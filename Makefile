DEPLOY_HOST = qibli.net
DEPLOY_PATH = /var/www/html/zorto

.PHONY: all frontend backend run deploy clean

all: backend

frontend:
	cd web && \
	npm install && \
	npm run build

backend: frontend
	go build .

run: frontend
	go run .

deploy: frontend
	rsync -avz --delete web/dist/ $(DEPLOY_HOST):$(DEPLOY_PATH)/

clean:
	rm -rf web/dist zorto
