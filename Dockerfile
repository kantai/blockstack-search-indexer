FROM node:12

WORKDIR /src/subdomain-registrar
# Copy files into container
COPY . .

RUN npm i

CMD npm run start fetch-to-json
