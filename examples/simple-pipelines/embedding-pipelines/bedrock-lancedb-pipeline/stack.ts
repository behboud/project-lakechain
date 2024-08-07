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

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as s3 from 'aws-cdk-lib/aws-s3';

import {
  TitanEmbeddingModel,
  TitanEmbeddingProcessor
} from '@project-lakechain/bedrock-embedding-processors';
import { CacheStorage } from '@project-lakechain/core';
import { EfsStorageProvider, LanceDbStorageConnector } from '@project-lakechain/lancedb-storage-connector';
import { PandocTextConverter } from '@project-lakechain/pandoc-text-converter';
import { PdfTextConverter } from '@project-lakechain/pdf-text-converter';
import { RecursiveCharacterTextSplitter } from '@project-lakechain/recursive-character-text-splitter';
import { S3EventTrigger } from '@project-lakechain/s3-event-trigger';
import { SharpImageTransform, sharp } from '@project-lakechain/sharp-image-transform';
import { Construct } from 'constructs';
/**
 * An example stack showcasing how to use Amazon Bedrock embeddings
 * and LanceDB for storing embeddings.
 * The pipeline looks as follows:
 *
 *
 *                   ┌──────────────────────┐
 *    ┌─────────────►│  PDF Text Converter  ├──────────┐
 *    │              └──────────────────────┘          |
 *    |                                                ▼
 * ┌──────────────┐   ┌────────────────────┐   ┌───────────────┐   ┌───────────┐   ┌───────────┐
 * │   S3 Input   ├──►│  Pandoc Converter  ├──►│ Text Splitter ├──►│  Bedrock  ├──►|  LanceDB  │
 * └──────────────┘   └────────────────────┘   └───────────────┘   └───────────┘   └───────────┘
 *
 */
export class BedrockLanceDbPipeline extends cdk.Stack {
  /**
   * Stack constructor.
   */
  constructor(scope: Construct, id: string, env: cdk.StackProps) {
    super(scope, id, {
      description: 'An embedding storage pipeline using Amazon Bedrock and LanceDB.',
      ...env
    });

    // The VPC required by the EFS storage.
    const vpc = this.createVpc('Vpc');

    ///////////////////////////////////////////
    ///////         S3 Storage          ///////
    ///////////////////////////////////////////

    // The source bucket where input documents are uploaded.
    const source = new s3.Bucket(this, 'Bucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enforceSSL: true
    });

    // The EFS file system used to store the embeddings.
    const fileSystem = new efs.FileSystem(this, 'FileSystem', {
      vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      throughputMode: efs.ThroughputMode.ELASTIC,
      encrypted: true,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED
      }
    });

    // The cache storage.
    const cache = new CacheStorage(this, 'CacheStorage', {});

    ///////////////////////////////////////////
    ///////     Lakechain Pipeline      ///////
    ///////////////////////////////////////////

    // Monitor a bucket for uploaded objects.
    const trigger = new S3EventTrigger.Builder()
      .withScope(this)
      .withIdentifier('Trigger')
      .withCacheStorage(cache)
      .withBucket(source)
      .build();

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

    // We use the `RecursiveCharacterTextSplitter` to split
    // input text into smaller chunks. This is required to ensure
    // that the generated embeddings are relevant.
    const textSplitter = new RecursiveCharacterTextSplitter.Builder()
      .withScope(this)
      .withIdentifier('RecursiveCharacterTextSplitter')
      .withCacheStorage(cache)
      .withSources([pdfConverter, pandocConverter, trigger])
      .withChunkSize(4096)
      .build();

    // Creates embeddings for text chunks using Amazon Titan.
    const embeddingProcessor = new TitanEmbeddingProcessor.Builder()
      .withScope(this)
      .withIdentifier('BedrockEmbeddingProcessor')
      .withCacheStorage(cache)
      .withSource(textSplitter)
      .withRegion('eu-central-1')
      .build();

    // Resize images to a width of 512px and convert them to PNG.
    const imageTransform = new SharpImageTransform.Builder()
      .withScope(this)
      .withIdentifier('SharpTransform')
      .withCacheStorage(cache)
      .withSource(trigger)
      .withSharpTransforms(sharp().resize(512).jpeg())
      .build();

    const imageEmbeddingProcessor = new TitanEmbeddingProcessor.Builder()
      .withScope(this)
      .withIdentifier('BedrockImageEmbeddingProcessor')
      .withCacheStorage(cache)
      .withSource(imageTransform)
      .withModel(TitanEmbeddingModel.AMAZON_TITAN_EMBED_IMAGE_V1)
      .withRegion('eu-central-1')
      .build();

    // Store the embeddings in LanceDB.
    new LanceDbStorageConnector.Builder()
      .withScope(this)
      .withIdentifier('LanceDbStorageConnector')
      .withCacheStorage(cache)
      .withSources([embeddingProcessor, imageEmbeddingProcessor])
      .withVectorSize(1024)
      .withStorageProvider(
        new EfsStorageProvider.Builder()
          .withScope(this)
          .withIdentifier('EfsStorage')
          .withFileSystem(fileSystem)
          .withVpc(vpc)
          .build()
      )
      .build();

    // Display the source bucket information in the console.
    new cdk.CfnOutput(this, 'SourceBucketName', {
      description: 'The name of the source bucket.',
      value: source.bucketName
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
      maxAzs: 1,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/20'),
      subnetConfiguration: [
        {
          // Used by NAT Gateways to provide Internet access
          // to the containers.
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 28
        },
        {
          // Used by the embedding containers.
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24
        },
        {
          // Used by EFS.
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 28
        }
      ]
    });
  }
}

// Creating the CDK application.
const app = new cdk.App();

// Environment variables.
const account = process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_DEFAULT_REGION;

// Deploy the stack.
new BedrockLanceDbPipeline(app, 'BedrockLanceDbPipeline', {
  env: {
    account,
    region
  }
});
