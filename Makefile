.PHONY: all frontend backend run deploy clean

all: backend

frontend:
	cd web && \
	npm install && \
	npm run build

backend: frontend
	go build .

run: frontend
	go run . --share=false

deploy: backend
	scp zorto qibli.net:/tmp/
	ssh -t qibli.net 'sudo install -m 755 /tmp/zorto /usr/local/bin/zorto && sudo systemctl restart zorto'

clean:
	rm -rf web/dist zorto
