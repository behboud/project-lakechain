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

import merge from 'lodash/merge';

import { LambdaInterface } from '@aws-lambda-powertools/commons/types';
import { BedrockRuntime } from '@aws-sdk/client-bedrock-runtime';
import { CacheStorage } from '@project-lakechain/sdk/cache';
import { next } from '@project-lakechain/sdk/decorators';
import { CloudEvent } from '@project-lakechain/sdk/models';
import { logger, tracer } from '@project-lakechain/sdk/powertools';
import { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import { TitanEmbeddingModel } from '../../definitions/embedding-model';

import { BatchProcessor, EventType, processPartialResponse } from '@aws-lambda-powertools/batch';

/**
 * Environment variables.
 */
const EMBEDDING_MODEL: TitanEmbeddingModel = JSON.parse(process.env.EMBEDDING_MODEL as string);

/**
 * The Bedrock runtime.
 */
const bedrock = tracer.captureAWSv3Client(
  new BedrockRuntime({
    region: process.env.BEDROCK_REGION || process.env.AWS_REGION,
    maxAttempts: 5
  })
);

/**
 * The async batch processor processes the received
 * events from SQS in parallel.
 */
const processor = new BatchProcessor(EventType.SQS);

/**
 * The middleware cache storage.
 */
const cacheStorage = new CacheStorage();

/**
 * The lambda class definition containing the lambda handler.
 * @note using a `LambdaInterface` is required in
 * this context in order to be able to use annotations
 * that are only supported on classes and methods.
 */
class Lambda implements LambdaInterface {
  /**
   * Creates vector embeddings for the given document
   * and references the vector embeddings in the metadata.
   * @param event the CloudEvent to process.
   */
  @next()
  private async processEvent(event: CloudEvent) {
    const document = event.data().document();
    const isText = document.mimeType().includes('text');
    // build the body of request
    const body = JSON.stringify({
      inputText: isText ? (await document.data().asBuffer()).toString('utf-8') : document.filename().name,
      inputImage: !isText ? (await document.data().asBuffer()).toString('base64') : undefined
    });
    // Vectorize the document.
    const response = await bedrock.invokeModel({
      body,
      modelId: EMBEDDING_MODEL.name,
      accept: 'application/json',
      contentType: 'application/json'
    });

    // Parse the response as a JSON object.
    const value = JSON.parse(response.body.transformToString());

    // Store the embeddings in the middleware cache storage.
    const pointer = await cacheStorage.put('embeddings', value.embedding);

    // We update the document metadata with the embeddings.
    merge(event.data().props.metadata, {
      properties: {
        kind: 'text',
        attrs: {
          embeddings: {
            vectors: pointer,
            model: EMBEDDING_MODEL.name,
            dimensions: EMBEDDING_MODEL.props?.dimensions
          }
        }
      }
    });

    return event;
  }

  /**
   * @param record the SQS record to process that contains
   * the EventBridge event providing information about the
   * S3 event.
   */
  async recordHandler(record: SQSRecord): Promise<CloudEvent> {
    return await this.processEvent(CloudEvent.from(JSON.parse(record.body)));
  }

  /**
   * The Lambda entry point.
   * @param event the received SQS event.
   * @param context the Lambda context.
   */
  @tracer.captureLambdaHandler()
  @logger.injectLambdaContext()
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async handler(event: SQSEvent, _: Context) {
    return await processPartialResponse(event, this.recordHandler.bind(this), processor);
  }
}

// The Lambda handler class.
const handlerClass = new Lambda();

// The handler function.
export const handler = handlerClass.handler.bind(handlerClass);
