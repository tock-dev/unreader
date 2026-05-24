#!/usr/bin/env bash
# Runs the server locally for easier testing

export JWT_SECRET='647eec3eda9940dede97a751a007c08e8e1fa3e6f39bcc50cf60f8b4e7ec1dc7'
export DATABASE_URL='postgresql://neondb_owner:npg_OLieqJ7wZ2Wk@ep-mute-union-apywmptr-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
export PORT=80

node index.js
