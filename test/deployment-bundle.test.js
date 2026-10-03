'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('company Docker bundle isolates PostgreSQL and requires generated secrets',()=>{
  const compose=read('docker-compose.company.yml'),dockerfile=read('Dockerfile');
  assert.match(compose,/POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?POSTGRES_PASSWORD is required\}/);
  assert.match(compose,/JWT_SECRET: \$\{JWT_SECRET:\?JWT_SECRET is required\}/);
  assert.doesNotMatch(compose.split('\n  app:')[0],/\n    ports:/);
  assert.match(compose,/condition: service_healthy/);
  assert.match(dockerfile,/USER bfg/);
  assert.match(dockerfile,/company-bootstrap\.js/);
});

test('production seed does not create shared default-password accounts',()=>{
  const seed=read('scripts/seed-besepar1.js'),bootstrap=read('scripts/company-bootstrap.js');
  assert.doesNotMatch(seed,/hashSync\('1234'/);
  assert.match(seed,/activation-required/);
  assert.match(bootstrap,/ADMIN_PASSWORD must contain at least 12 characters/);
  assert.match(bootstrap,/startup will not reset its password/);
});
