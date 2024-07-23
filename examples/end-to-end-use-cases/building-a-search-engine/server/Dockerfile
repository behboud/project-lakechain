FROM public.ecr.aws/lambda/python:3.12

RUN dnf update -y
RUN dnf install -y git
RUN mkdir -p ~/.cache
RUN curl -L https://openaipublic.azureedge.net/clip/models/40d365715913c9da98579312b702a82c18be219cc2a73407c4526f58eba950af/ViT-B-32.pt -o ~/.cache/ViT-B-32.pt
COPY . ${LAMBDA_TASK_ROOT}

# Install the specified packages
RUN pip install -r requirements.txt
RUN pip3 install fastapi --target "${LAMBDA_TASK_ROOT}"
CMD ["main.handler"]