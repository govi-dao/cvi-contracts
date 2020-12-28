FROM node:10.20.1

USER root

####################################################################################################################
# Env
ENV VERSION "0.8"
ENV COMMAND "migrate"
ENV API_HOST "0.0.0.0"
ENV API_PORT "8888"
ENV NETWORK "development"
ENV SRC_DIR "/project"
ENV TRUFFLE_VERSION "5.0.10"

####################################################################################################################
# Install
RUN npm install -g truffle@$TRUFFLE_VERSION && npm config set bin-links false

####################################################################################################################
# Create project directory
RUN mkdir -p $SRC_DIR

WORKDIR $SRC_DIR

COPY ./package*.json ./

RUN npm install --build-from-resource

COPY . .

####################################################################################################################
# Scripts
ADD ./.scripts/run.sh /scripts/run.sh
ADD ./.scripts/package.json /scripts/package.json
ADD ./.scripts/api.js /scripts/api.js

RUN chmod +x /scripts/run.sh

####################################################################################################################
# Run
EXPOSE $API_PORT

WORKDIR $SRC_DIR

CMD ["/scripts/run.sh"]