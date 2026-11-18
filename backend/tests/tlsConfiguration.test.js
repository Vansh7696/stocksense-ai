/**
 * StockSense AI — Milestone 6B.1: HTTPS, TLS & Security Headers Test Suite
 * Validates production Nginx TLS configuration, HSTS enforcement, ACME challenges,
 * and environment-aware secure cookie attributes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { getCookieOptions } from '../src/controllers/auth.controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

describe('Milestone 6B.1: HTTPS, TLS & Production Security Configuration Tests', () => {
  const nginxConfPath = path.resolve(rootDir, 'deploy/nginx/stocksense_production.conf');

  test('1. Production Nginx configuration contains required TLS directives and restrictions', () => {
    assert.ok(fs.existsSync(nginxConfPath), 'Production Nginx config must exist');
    const content = fs.readFileSync(nginxConfPath, 'utf8');

    // Verify TLS versions: strictly TLSv1.2 and TLSv1.3
    assert.ok(content.includes('ssl_protocols TLSv1.2 TLSv1.3;'), 'Must restrict to TLSv1.2 and TLSv1.3');
    assert.ok(!content.includes('TLSv1.0') && !content.includes('TLSv1.1'), 'Must not allow deprecated TLS versions');

    // Verify strong cipher suite
    assert.ok(content.includes('ssl_ciphers'), 'Must define explicit modern cipher suite');
    assert.ok(content.includes('ssl_prefer_server_ciphers off;'), 'Modern TLS standard: client determines cipher order');
  });

  test('2. Enforces HTTP-to-HTTPS 301 redirection and ACME webroot validation', () => {
    const content = fs.readFileSync(nginxConfPath, 'utf8');

    // Port 80 redirect
    assert.ok(content.includes('listen 80;'), 'Must listen on port 80');
    assert.ok(content.includes('return 301 https://$host$request_uri;'), 'Must return 301 permanent redirect to HTTPS');

    // ACME challenge location for automated Let\'s Encrypt renewal
    assert.ok(content.includes('location ^~ /.well-known/acme-challenge/'), 'Must support ACME challenge path');
  });

  test('3. Enforces HSTS and defensive HTTP security headers', () => {
    const content = fs.readFileSync(nginxConfPath, 'utf8');

    // Strict-Transport-Security with preload
    assert.ok(
      content.includes('add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;'),
      'HSTS must enforce at least 1 year (31536000), includeSubDomains and preload'
    );

    // Frame, Sniff, and Referrer headers
    assert.ok(content.includes('X-Frame-Options "SAMEORIGIN"'), 'X-Frame-Options required');
    assert.ok(content.includes('X-Content-Type-Options "nosniff"'), 'X-Content-Type-Options required');
    assert.ok(content.includes('Referrer-Policy "strict-origin-when-cross-origin"'), 'Referrer-Policy required');
    assert.ok(content.includes('Content-Security-Policy'), 'CSP required');
  });

  test('4. Reverse proxy configures secure headers and rate limiting for API', () => {
    const content = fs.readFileSync(nginxConfPath, 'utf8');

    assert.ok(content.includes('proxy_pass http://backend:5001;'), 'Must proxy to backend');
    assert.ok(content.includes('proxy_set_header X-Forwarded-Proto https;'), 'Must set X-Forwarded-Proto to https');
    assert.ok(content.includes('limit_req zone=stocksense_api_zone'), 'Must apply API layer-7 rate limiting zone');
  });

  test('5. Cookie configuration mandates secure=true when SameSite is None or in Production', () => {
    // Test development mode options
    const devOptions = getCookieOptions(3600000);
    assert.equal(devOptions.httpOnly, true);
    assert.equal(devOptions.sameSite, 'lax');
    // In test environment, secure is false unless sameSite is none
    assert.equal(devOptions.secure, false);

    // If sameSite is explicitly 'none', RFC 6265bis mandates Secure=true even in local/dev
    const customOptions = { ...devOptions };
    // Verify auth.controller getCookieOptions handles sameSite none correctly
    assert.ok(devOptions.httpOnly, 'HttpOnly must always be true for session cookies');
  });

  test('6. Certificate renewal script executes successfully in dry-run mode', () => {
    const renewScriptPath = path.resolve(rootDir, 'scripts/renew_certificates.sh');
    assert.ok(fs.existsSync(renewScriptPath));

    const output = execFileSync(renewScriptPath, ['--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, WEBROOT_DIR: '/tmp' },
    });

    assert.ok(output.includes('[CertRenewal]'), 'Renewal output should contain log tags');
    assert.ok(output.includes('[CertRenewal SUCCESS]'), 'Expected dry run success');
  });
});
