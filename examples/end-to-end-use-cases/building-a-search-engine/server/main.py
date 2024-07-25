#  Copyright (C) 2023 Amazon.com, Inc. or its affiliates.
#
#  Licensed under the Apache License, Version 2.0 (the "License");
#  you may not use this file except in compliance with the License.
#  You may obtain a copy of the License at
#
#       http://www.apache.org/licenses/LICENSE-2.0
#
#  Unless required by applicable law or agreed to in writing, software
#  distributed under the License is distributed on an "AS IS" BASIS,
#  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#  See the License for the specific language governing permissions and
#  limitations under the License.

from urllib.parse import unquote

from embeddings.image_embeddings import clip_create_text_embeddings
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from mangum import Mangum
from opensearch import (create_opensearch_client, delete_documents,
                        delete_images, image_semantic_search,
                        text_semantic_search)
from params import aws_region, es_hostname, es_port
from utils import presign_url

# Create the FastAPI app.
app = FastAPI()

# Mount the static files directory.
app.mount("/static", StaticFiles(directory="static"), name="static")

# Mount the templates directory.
templates = Jinja2Templates(directory="templates")

# Create the OpenSearch client.
client = create_opensearch_client(
    endpoint=es_hostname,
    port=es_port,
    region_name=aws_region
)


@app.get("/")
def index(request: Request):
    """
    Renders the index page.
    :param request: The HTTP request.
    """
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/search")
def search_documents(request: Request):
    """
    Performs a semantic search on documents given the search text.
    :param request: The HTTP request.
    """
    query = request.query_params.get('q')

    # Text semantic search.
    results = text_semantic_search(client=client, search=query)

    # Add a presigned URL to the results and
    # extract metadata from the results.
    for result in results:
        source = result['source']
        metadata = result['metadata']
        source['presigned_url'] = presign_url(
            s3_url=source['url'], region=aws_region)
        source['title'] = metadata['title'] if 'title' in metadata else unquote(
            source['url'].split('/')[-1])

    # Render the results.
    return templates.TemplateResponse("search.html", {"request": request, "results": results})


@app.get("/search/images")
def search_images(request: Request):
    """
    Performs a semantic search for images given the search text.
    :param request: The HTTP request.
    """
    query = request.query_params.get('q')

    # Image semantic search.
    results = image_semantic_search(client=client, search=query)

    # Add a presigned URL to the results.
    for result in results:
        document = result['_source']['data']['document']
        document['presigned_url'] = presign_url(
            s3_url=document['url'], region=aws_region)

    # Render the results.
    return templates.TemplateResponse("image-search.html", {"request": request, "results": results})


@app.delete("/documents")
def delete_documents_from_index():
    """
    Deletes all documents from the index.
    """
    return delete_documents(client)


@app.delete("/images")
def delete_images_from_index():
    """
    Deletes all images from the index.
    """
    return delete_images(client)


# post method to receive a string as part of the request body and return the CLIP embedding

@app.post("/embedding")
async def get_clip_embedding(request: Request):
    """
    Returns the CLIP embedding for the given text.
    :param request: The HTTP request.
    """
    text = await request.body()
    text = text.decode('utf-8')
    # Call the get_clip_embedding function with the text
    # and return the embedding
    # TODO: raises runtime error for too long context length
    embedding = clip_create_text_embeddings(text)
    return {"embedding": embedding}


handler = Mangum(app)
