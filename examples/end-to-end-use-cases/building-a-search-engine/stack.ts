#!/usr/bin/env node

/*
 * Copyright (C) 2023 Amazon.com, Inc. or its affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  CohereEmbeddingModel,
  CohereEmbeddingProcessor
} from '@project-lakechain/bedrock-embedding-processors';
import { ClipImageProcessor } from '@project-lakechain/clip-image-processor';
import { CacheStorage } from '@project-lakechain/core';
import { KeybertTextProcessor } from '@project-lakechain/keybert-text-processor';
import { OpenSearchDomain } from '@project-lakechain/opensearch-domain';
import {
  OpenSearchVectorIndexDefinition,
  OpenSearchVectorStorageConnector
} from '@project-lakechain/opensearch-vector-storage-connector';
import { PandocTextConverter } from '@project-lakechain/pandoc-text-converter';
import { PdfTextConverter } from '@project-lakechain/pdf-text-converter';
import { RecursiveCharacterTextSplitter } from '@project-lakechain/recursive-character-text-splitter';
import { S3EventTrigger } from '@project-lakechain/s3-event-trigger';
import { SharpImageTransform, sharp } from '@project-lakechain/sharp-image-transform';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * An example showcasing how to build an end-to-end
 * search engine multi-modal ingestion system that indexes
 * text, images and audio using Amazon OpenSearch.
 */
export class SearchEnginePipeline extends cdk.Stack {
  /**
   * Stack constructor.
   */
  constructor(scope: Construct, id: string, env: cdk.StackProps) {
    super(scope, id, {
      description: 'An end-to-end search engine multi-modal ingestion pipeline using Amazon OpenSearch.',
      ...env
    });

    // The VPC in which OpenSearch will be deployed.
    const vpc = this.createVpc('Vpc');

    // The OpenSearch domain.
    const openSearch = new OpenSearchDomain(this, 'Domain', {
      vpc
    });

    // The source bucket.
    const bucket = new s3.Bucket(this, 'Bucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enforceSSL: true
    });

    // The cache storage.
    const cache = new CacheStorage(this, 'Cache', {});

    ///////////////////////////////////////////
    //////     Pipeline Data Sources     //////
    ///////////////////////////////////////////

    // Create the S3 trigger monitoring the bucket
    // for uploaded objects.
    const trigger = new S3EventTrigger.Builder()
      .withScope(this)
      .withIdentifier('Trigger')
      .withCacheStorage(cache)
      .withBucket(bucket)
      .build();

    ///////////////////////////////////////////
    ///     Pipeline Document Converters    ///
    ///////////////////////////////////////////

    // Convert PDF documents to text.
    const pdfConverter = new PdfTextConverter.Builder()
      .withScope(this)
      .withIdentifier('PdfConverter')
      .withCacheStorage(cache)
      .withSource(trigger)
      .build();

    // Convert text-oriented documents (Docx, Markdown, HTML, etc) to text.
    const pandocConverter = new PandocTextConverter.Builder()
      .withScope(this)
      .withIdentifier('PandocConverter')
      .withCacheStorage(cache)
      .withSource(trigger)
      .build();

    // Resize images to a width of 512px and convert them to PNG.
    const imageTransform = new SharpImageTransform.Builder()
      .withScope(this)
      .withIdentifier('SharpTransform')
      .withCacheStorage(cache)
      .withSource(trigger)
      .withSharpTransforms(sharp().resize(512).png())
      .build();

    ///////////////////////////////////////////
    //////////    Topic Modeling     //////////
    ///////////////////////////////////////////

    // Performs topic modeling by extracting keywords
    // from text using KeyBERT.
    const keybertProcessor = new KeybertTextProcessor.Builder()
      .withScope(this)
      .withIdentifier('KeybertProcessor')
      .withCacheStorage(cache)
      .withSources([trigger, pdfConverter, pandocConverter])
      .withVpc(vpc)
      .build();

    ///////////////////////////////////////////
    //////////     Text Splitter     //////////
    ///////////////////////////////////////////

    // Split the text into chunks.
    const textSplitter = new RecursiveCharacterTextSplitter.Builder()
      .withScope(this)
      .withIdentifier('RecursiveCharacterTextSplitter')
      .withCacheStorage(cache)
      .withChunkSize(2048)
      .withSource(keybertProcessor)
      .build();

    /////////////////////////////////////
    ////   Embeddings with Bedrock   ////
    /////////////////////////////////////

    // Create embeddings for each chunk of text using
    // the Cohere embedding multilingual model hosted
    // on Amazon Bedrock.
    const cohereProcessor = new CohereEmbeddingProcessor.Builder()
      .withScope(this)
      .withIdentifier('CohereEmbeddingProcessor')
      .withCacheStorage(cache)
      .withSource(textSplitter)
      .withRegion(env.env?.region || 'eu-central-1')
      .withModel(CohereEmbeddingModel.COHERE_EMBED_MULTILINGUAL_V3)
      .build();

    // Create embeddings for images using CLIP.
    const clipProcessor = new ClipImageProcessor.Builder()
      .withScope(this)
      .withIdentifier('ClipImageProcessor')
      .withCacheStorage(cache)
      .withSource(imageTransform)
      .withVpc(vpc)
      .build();

    ///////////////////////////////////////////
    ////     Pipeline Storage Providers    ////
    ///////////////////////////////////////////

    // Vector storage for text.
    new OpenSearchVectorStorageConnector.Builder()
      .withScope(this)
      .withIdentifier('TextVectorStorage')
      .withCacheStorage(cache)
      .withEndpoint(openSearch.domain)
      .withSource(cohereProcessor)
      .withVpc(vpc)
      .withIncludeDocument(true)
      .withIndex(
        new OpenSearchVectorIndexDefinition.Builder()
          .withIndexName('text-vectors')
          .withKnnMethod('hnsw')
          .withKnnEngine('nmslib')
          .withSpaceType('l2')
          .withDimensions(1024)
          .withParameters({ ef_construction: 512, m: 16 })
          .build()
      )
      .build();

    // Vector storage for images.
    new OpenSearchVectorStorageConnector.Builder()
      .withScope(this)
      .withIdentifier('ImageVectorStorage')
      .withCacheStorage(cache)
      .withEndpoint(openSearch.domain)
      .withSource(clipProcessor)
      .withVpc(vpc)
      .withIndex(
        new OpenSearchVectorIndexDefinition.Builder()
          .withIndexName('image-vectors')
          .withKnnMethod('hnsw')
          .withKnnEngine('nmslib')
          .withSpaceType('cosinesimil')
          .withDimensions(512)
          .withParameters({ ef_construction: 512, m: 16 })
          .build()
      )
      .build();

    const clipServer = new CLIPServer(this, 'CLIPServer', {
      env: {
        account: env.env?.account,
        region: env.env?.region
      },
      opensearchDomain: openSearch.domain,
      vpc,
    });
    clipServer.node.addDependency(openSearch)
    // Display the source bucket information in the console.
    new cdk.CfnOutput(this, 'SourceBucket', {
      description: 'The name of the source bucket.',
      value: bucket.bucketName
    });

    // Display the OpenSearch endpoint.
    new cdk.CfnOutput(this, 'OpenSearchEndpoint', {
      description: 'The endpoint of the OpenSearch domain.',
      value: `https://${openSearch.domain.domainEndpoint}`
    });
  }

  /**
   * @param id the VPC identifier.
   * @returns a new VPC with a public, private and isolated
   * subnets for the pipeline.
   */
  private createVpc(id: string): ec2.IVpc {
    return new ec2.Vpc(this, id, {
      enableDnsSupport: true,
      enableDnsHostnames: true,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/20'),
      maxAzs: 1,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 28
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24
        },
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24
        }
      ]
    });
  }
}

interface CLIPServerProps extends cdk.StackProps {
  opensearchDomain: cdk.aws_opensearchservice.IDomain;
  vpc: ec2.IVpc;
}
export class CLIPServer extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: CLIPServerProps) {
    super(scope, id, props);

    // Build and push Docker image to ECR
    const dockerImage = new ecrAssets.DockerImageAsset(this, 'CLIPServerImage', {
      directory: path.join(__dirname, 'server') // Path to your Dockerfile and app code
    });

    // Create a Lambda function from the Docker image
    const lambdaFunction = new lambda.DockerImageFunction(this, 'CLIPServerLambda', {
      code: lambda.DockerImageCode.fromEcr(dockerImage.repository, {
        tagOrDigest: dockerImage.imageTag
      }),
      memorySize: 4096,
      timeout: cdk.Duration.seconds(35),
      environment: {
        OPENSEARCH_HOSTNAME: props?.opensearchDomain.domainEndpoint || '',
        BEDROCK_REGION: props?.env?.region || this.region,
      },
      vpc: props?.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ephemeralStorageSize: cdk.Size.gibibytes(1),
    });

    props?.opensearchDomain.grantReadWrite(lambdaFunction)
    // Grant Lambda permission to invoke Bedrock
    lambdaFunction.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
     resources: [`arn:aws:bedrock:eu-central-1::foundation-model/cohere.embed-multilingual-v3`],
    }));

    // Create an API Gateway
    const api = new apigateway.LambdaRestApi(this, 'CLIPServerAPI', {
      handler: lambdaFunction,
      deployOptions: {
        stageName: 'dev',
      },
      proxy: true // This enables proxying all requests to the Lambda function
    });
    
  }
}

// Creating the CDK application.
const app = new cdk.App();

// Environment variables.
const account = process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_DEFAULT_REGION;

// Deploy the stack.
new SearchEnginePipeline(app, 'SearchEnginePipeline', {
  env: {
    account,
    region
  }
});
