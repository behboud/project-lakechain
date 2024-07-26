FROM python:3

# Install dependencies.
RUN export DEBIAN_FRONTEND=noninteractive \
  && apt-get -y update \
  && apt-get -y install --no-install-recommends git

# Create a new user for running the application.
ARG UID=1000
RUN adduser --uid ${UID} --disabled-password docker-user

# Switch to the docker user.
USER docker-user
WORKDIR /home/docker-user

# Install Python dependencies.
COPY . /home/docker-user
# Install Python dependencies
RUN pip install --no-cache-dir --upgrade -r requirements.txt

CMD ["python","-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
