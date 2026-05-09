DEPLOY_HOST = qibli.net
DEPLOY_PATH = /var/www/html/djot-editor

.PHONY: build deploy clean

build:
	npm run build

deploy: build
	rsync -avz --delete dist/ $(DEPLOY_HOST):$(DEPLOY_PATH)/

clean:
	rm -rf dist
