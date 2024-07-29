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

import path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as node from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as r from '@project-lakechain/core/dsl/vocabulary/reference';

import { Construct } from 'constructs';
import { ServiceDescription } from '@project-lakechain/core/service';
import { ComputeType } from '@project-lakechain/core/compute-type';
import { when } from '@project-lakechain/core/dsl/vocabulary/conditions';
import { CacheStorage } from '@project-lakechain/core';
import { LlamaModel } from './definitions/model';

import {
  LlamaTextProcessorProps,
  LlamaTextProcessorPropsSchema,
  ModelParameters
} from './definitions/opts.js';
import {
  Middleware,
  MiddlewareBuilder,
  LAMBDA_INSIGHTS_VERSION,
  NAMESPACE
} from '@project-lakechain/core/middleware';

/**
 * The service description.
 */
const description: ServiceDescription = {
  name: 'llama-text-processor',
  description: 'Generative text processing using Llama models on Amazon Bedrock.',
  version: '0.7.0',
  attrs: {}
};

/**
 * The maximum time the processing lambda
 * is allowed to run.
 */
const PROCESSING_TIMEOUT = cdk.Duration.minutes(2);

/**
 * The execution runtime for used compute.
 */
const EXECUTION_RUNTIME  = lambda.Runtime.NODEJS_18_X;

/**
 * The default memory size to allocate for the compute.
 */
const DEFAULT_MEMORY_SIZE = 128;

/**
 * The builder for the `LlamaTextProcessor` service.
 */
class LlamaTextProcessorBuilder extends MiddlewareBuilder {
  private middlewareProps: Partial<LlamaTextProcessorProps> = {};

  /**
   * Sets the Llama model to use for generating text.
   * @param model the Llama text model to use.
   * @returns the current builder instance.
   */
  public withModel(model: LlamaModel) {
    this.middlewareProps.model = model;
    return (this);
  }

  /**
   * Sets the parameters to pass to the text model.
   * @param parameters the parameters to pass to the text model.
   * @default {}
   * @returns the current builder instance.
   */
  public withModelParameters(parameters: ModelParameters) {
    this.middlewareProps.modelParameters = parameters;
    return (this);
  }

  /**
   * Sets the system prompt to use for generating text.
   * @param prompt the system prompt to use for generating text.
   * @returns the current builder instance.
   */
  public withSystemPrompt(prompt: string) {
    this.middlewareProps.systemPrompt = prompt;
    return (this);
  }

  /**
   * Sets the prompt to use for generating text.
   * @param prompt the prompt to use for generating text.
   * @returns the current builder instance.
   */
  public withPrompt(prompt: string | r.IReference<any>) {
    let reference = null;

    if (typeof prompt === 'string') {
      reference = r.reference(r.value(prompt));
    } else {
      reference = prompt;
    }

    this.middlewareProps.prompt = reference;
    return (this);
  }

  /**
   * Sets the assistant prefill to use for generating text.
   * @param prefill the assistant prefill to use for generating text.
   * @returns the current builder instance.
   * @default ''
   */
  public withAssistantPrefill(prefill: string) {
    this.middlewareProps.assistantPrefill = prefill;
    return (this);
  }
  
  /**
   * Sets the AWS region in which the model
   * will be invoked.
   * @param region the AWS region in which the model
   * will be invoked.
   * @returns the current builder instance.
   */
  public withRegion(region: string) {
    this.middlewareProps.region = region;
    return (this);
  }

  /**
   * @returns a new instance of the `LlamaTextProcessor`
   * service constructed with the given parameters.
   */
  public build(): LlamaTextProcessor {
    return (new LlamaTextProcessor(
      this.scope,
      this.identifier, {
        ...this.middlewareProps as LlamaTextProcessorProps,
        ...this.props
      }
    ));
  }
}

/**
 * A service providing text generation using Llama models
 * on Amazon Bedrock.
 */
export class LlamaTextProcessor extends Middleware {

  /**
   * The storage containing processed files.
   */
  public storage: CacheStorage;

  /**
   * The data processor lambda function.
   */
  public eventProcessor: lambda.IFunction;

  /**
   * The builder for the `LlamaTextProcessor` service.
   */
  public static readonly Builder = LlamaTextProcessorBuilder;

  /**
   * Construct constructor.
   */
  constructor(scope: Construct, id: string, private props: LlamaTextProcessorProps) {
    super(scope, id, description, {
      ...props,
      queueVisibilityTimeout: cdk.Duration.seconds(
        2 * PROCESSING_TIMEOUT.toSeconds()
      )
    });

    // Validate the properties.
    this.props = this.parse(LlamaTextProcessorPropsSchema, props);

    ///////////////////////////////////////////
    ////////    Processing Storage      ///////
    ///////////////////////////////////////////

    this.storage = new CacheStorage(this, 'Storage', {
      encryptionKey: props.kmsKey
    });

    ///////////////////////////////////////////
    //////////    Prompt Handler      /////////
    ///////////////////////////////////////////

    // If the given prompt is a static value, and it is bigger than a certain
    // threshold, we upload the prompt to the internal storage and reference it
    // in the lambda environment.
    if (this.props.prompt.subject.type === 'value'
      && this.props.prompt.subject.value.length > 3072) {
      // Upload the prompt as a document in the internal storage.
      new s3deploy.BucketDeployment(this, 'Prompt', {
        sources: [s3deploy.Source.data('prompt.txt', this.props.prompt.subject.value)],
        destinationBucket: this.storage.getBucket()
      });
      this.props.prompt = r.reference(r.url(`s3://${this.storage.getBucket().bucketName}/prompt.txt`));
    }
    
    ///////////////////////////////////////////
    //////    Middleware Event Handler     ////
    ///////////////////////////////////////////

    this.eventProcessor = new node.NodejsFunction(this, 'Compute', {
      description: 'Generates text using Llama models on Amazon Bedrock.',
      entry: path.resolve(__dirname, 'lambdas', 'handler', 'index.js'),
      vpc: this.props.vpc,
      memorySize: this.props.maxMemorySize ?? DEFAULT_MEMORY_SIZE,
      timeout: PROCESSING_TIMEOUT,
      runtime: EXECUTION_RUNTIME,
      architecture: lambda.Architecture.ARM_64,
      tracing: lambda.Tracing.ACTIVE,
      environmentEncryption: this.props.kmsKey,
      logGroup: this.logGroup,
      insightsVersion: this.props.cloudWatchInsights ?
        LAMBDA_INSIGHTS_VERSION :
        undefined,
      environment: {
        POWERTOOLS_SERVICE_NAME: description.name,
        POWERTOOLS_METRICS_NAMESPACE: NAMESPACE,
        SNS_TARGET_TOPIC: this.eventBus.topicArn,
        PROCESSED_FILES_BUCKET: this.storage.id(),
        MODEL_ID: this.props.model.name,
        SYSTEM_PROMPT: this.props.systemPrompt ?? '',
        PROMPT: JSON.stringify(this.props.prompt),
        ASSISTANT_PREFILL: this.props.assistantPrefill,
        MODEL_PARAMETERS: JSON.stringify(this.props.modelParameters),
        BEDROCK_REGION: this.props.region ?? cdk.Aws.REGION,
        OVERFLOW_STRATEGY: this.props.overflowStrategy
      },
      bundling: {
        minify: true,
        externalModules: [
          '@aws-sdk/client-s3',
          '@aws-sdk/client-sns'
        ]
      }
    });

    // Allows this construct to act as a `IGrantable`
    // for other middlewares to grant the processing
    // lambda permissions to access their resources.
    this.grantPrincipal = this.eventProcessor.grantPrincipal;

    // Plug the SQS queue into the lambda function.
    this.eventProcessor.addEventSource(new sources.SqsEventSource(this.eventQueue, {
      batchSize: this.props.batchSize ?? 1,
      maxConcurrency: 2,
      reportBatchItemFailures: true
    }));

    // Allow access to the Bedrock API.
    this.eventProcessor.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel'
      ],
      resources: [
        `arn:${cdk.Aws.PARTITION}:bedrock:${this.props.region ?? cdk.Aws.REGION}::foundation-model/${this.props.model.name}`,
      ]
    }));

    // Grant the compute type permissions to
    // write to the post-processing storage.
    this.storage.grantWrite(this.grantPrincipal);

    // Grant the compute type permissions to
    // publish to the SNS topic.
    this.eventBus.grantPublish(this.grantPrincipal);

    super.bind();
  }

  /**
   * Allows a grantee to read from the processed documents
   * generated by this middleware.
   */
  grantReadProcessedDocuments(grantee: iam.IGrantable): iam.Grant {
    return (this.storage.grantRead(grantee));
  }

  /**
   * @returns an array of mime-types supported as input
   * type by this middleware.
   */
  supportedInputTypes(): string[] {
    return ([
      'text/plain',
      'text/markdown',
      'text/csv',
      'text/html',
      'application/x-subrip',
      'text/vtt',
      'application/json',
      'application/xml',
      'application/json+scheduler'
    ]);
  }

  /**
   * @returns an array of mime-types supported as output
   * type by the data producer.
   */
  supportedOutputTypes(): string[] {
    return ([
      'text/plain'
    ]);
  }

  /**
   * @returns the supported compute types by a given
   * middleware.
   */
  supportedComputeTypes(): ComputeType[] {
    return ([
      ComputeType.CPU
    ]);
  }

  /**
   * @returns the middleware conditional statement defining
   * in which conditions this middleware should be executed.
   * In this case, we want the middleware to only be invoked
   * when the document mime-type is supported, and the event
   * type is `document-created`.
   */
  conditional() {
    return (super
      .conditional()
      .and(when('type').equals('document-created'))
    );
  }
}

export { LlamaModel } from './definitions/model';