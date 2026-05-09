DEPLOY_HOST = qibli.net
DEPLOY_PATH = /var/www/html/djot-editor

.PHONY: build server deploy clean

build:
	cd web && npm run build

server: build
	go run .

deploy: build
	rsync -avz --delete web/dist/ $(DEPLOY_HOST):$(DEPLOY_PATH)/

clean:
	rm -rf web/dist djot-editor
