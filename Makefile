.PHONY: all frontend backend run deploy clean

all: backend

frontend:
	cd web && \
	npm install && \
	npm run build

backend: frontend
	go build .

run: frontend
	AUTH0_DOMAIN=qibli.eu.auth0.com \
	AUTH0_CLIENT_ID=BSkEg9dGo0HrrOyuILxZRPREmOuLFLOq \
	AUTH0_AUDIENCE=https://qibli.net \
	go run .

deploy: backend
	scp zorto qibli.net:/tmp/
	ssh -t qibli.net 'sudo install -m 755 /tmp/zorto /usr/local/bin/zorto && sudo systemctl restart zorto'

clean:
	rm -rf web/dist zorto
