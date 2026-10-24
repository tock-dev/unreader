# Testing and contribute

So. You want to contribute right? (insert Lord Verity "NOOOOO" reaction here because I'm lazy as shit) Well you're in luck!
We're not giving out any internal database stuff, but you can host your own with locally made databases, and make required changes!


# PREREQUISITES

I assume you have all of these installed:
- Git
- Node.JS
- PostgreSQL (skip if your testing environment contains a service like Neon or Supabase.)
- A browser, preferably Chromium 75. (Skip if you can test on a Kindle, preferably on firmware 5.16.4 and above.)

# Set up the environment.

First step is to set this up. Start by cloning the repo by going to your preferred location, open a terminal there, then
``` bash
git clone https://github.com/tock-dev/unreader.git
cd unreader
```
For the hosting, create an empty database with the provider of choice, or if using PostgreSQL, use this [guide](https://www.geeksforgeeks.org/postgresql/create-database-postgresql/).
Then, start adding your own environment variables.
For starters, here's a reference from our run.sh script (creds stripped, nice try.)

``` bash
#!/usr/bin/env bash
# This script runs the node server

export JWT_SECRET='eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IjE4MWMzOGZkOWI1NDQ2NmYwNzFkYzI5OGIwMDM1YjNmIn0' # whatever fits your JWT needs, unsure how tock whipped this up, but ok.
export DATABASE_URL='postgresql://username:password@hostname:port/database_name?sslmode=require&channel_binding=require'
export PORT=80

node index.js
```

Now that all is set up, on your PC, go to 127.0.0.1:80 to test, if you used the same port as the example script.
If you also want to test on your Kindle, make sure to keep port 80, since for some reason the browser rejects port numbers. Check your PC's local IP address, then go to that IP address on your Kindle.
