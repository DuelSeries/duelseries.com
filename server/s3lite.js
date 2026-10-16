'use strict';
/* ─── The few S3 and CloudFront calls the clip uploads need, signed by hand ───────
   Players' clips go from their browser straight into a private S3 bucket and are
   watched through CloudFront, so the game box never carries the video (server/clips.js).
   The server only needs to: hand out a short-lived upload link, read a few bytes of an
   upload to check it, copy an approved one to where CloudFront reads, delete, and clear
   CloudFront's copy of a clip that was taken down.

   That is six requests, so they are signed here with AWS Signature Version 4 (the
   documented algorithm, about a page of code) instead of adding the AWS SDK, which is
   tens of packages to install and audit on every deploy for the same six requests.
   test/s3lite.test.js checks the signatures against AWS's own published examples.

   The key it signs with belongs to an IAM user that can touch only this bucket's
   inbox/ and live/ folders and clear only this distribution's cache. */

const crypto = require('crypto');

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
const EMPTY_SHA = sha256hex('');

// RFC 3986, as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ is %XX.
function enc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
const encPath = (p) => p.split('/').map(enc).join('/');

function amzDates(now) {
  const iso = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');   // 20130524T000000Z
  return { amzDate: iso, day: iso.slice(0, 8) };
}

function signingKey(secret, day, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, day), region), service), 'aws4_request');
}

/* The signature over one request. headers: lower-case names -> values (host included).
   query: name -> value, before signing. Returns { signature, signedHeaders, scope }. */
function sign({ method, path, query = {}, headers, payloadHash, creds, region, service, now }) {
  const { amzDate, day } = amzDates(now);
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = String(headers[k]).trim().replace(/\s+/g, ' ');
  const canonicalHeaders = names.map((h) => h + ':' + lower[h] + '\n').join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.keys(query).sort().map((k) => enc(k) + '=' + enc(String(query[k]))).join('&');
  const canonical = [method, encPath(path), canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = day + '/' + region + '/' + service + '/aws4_request';
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(creds.secret, day, region, service)).update(toSign).digest('hex');
  return { signature, signedHeaders, scope, amzDate };
}

/* A bucket and the key that may use it.
     bucket, region           where the clips live
     creds { id, secret }     the IAM user's access key
     fetchImpl                fetch (tests pass a fake)
     now                      clock (tests) */
function createS3({ bucket, region, creds, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 }) {
  if (!bucket || !region || !creds || !creds.id || !creds.secret) throw new Error('s3lite: bucket, region and creds are required');
  const host = bucket + '.s3.' + region + '.amazonaws.com';

  /* A link the browser can PUT one object to, for `expires` seconds. The size and the
     type are part of the signature, so S3 refuses a body of any other length or type:
     the size cap holds even though the bytes never pass through this server. */
  function presignPut(key, { contentType, contentLength, expires = 600, once = false }) {
    const headers = { 'content-length': String(contentLength), 'content-type': contentType };
    // once: S3 writes only if the key is empty (a conditional write), so the link cannot replace its own file.
    if (once) headers['if-none-match'] = '*';
    return presign('PUT', key, headers, {}, expires);
  }
  // A link to read one object for `expires` seconds (the owner's look at a clip still waiting).
  function presignGet(key, { expires = 900, responseType } = {}) {
    const extra = responseType ? { 'response-content-type': responseType } : {};
    return presign('GET', key, {}, extra, expires);
  }
  function presign(method, key, headers, extraQuery, expires) {
    const t = now();
    const { amzDate, day } = amzDates(t);
    const path = '/' + key;
    const h = Object.assign({ host }, headers);
    const query = Object.assign({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': creds.id + '/' + day + '/' + region + '/s3/aws4_request',
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expires),
      'X-Amz-SignedHeaders': Object.keys(h).map((x) => x.toLowerCase()).sort().join(';'),
    }, extraQuery);
    const s = sign({ method, path, query, headers: h, payloadHash: 'UNSIGNED-PAYLOAD', creds, region, service: 's3', now: t });
    const qs = Object.keys(query).sort().map((k) => enc(k) + '=' + enc(String(query[k]))).join('&');
    return 'https://' + host + encPath(path) + '?' + qs + '&X-Amz-Signature=' + s.signature;
  }

  // One header-signed request to the bucket. Returns the fetch Response.
  async function call(method, key, { headers = {}, body = null } = {}) {
    const t = now();
    const payloadHash = body ? sha256hex(body) : EMPTY_SHA;
    const { amzDate } = amzDates(t);
    const h = Object.assign({ host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash }, headers);
    const s = sign({ method, path: '/' + key, headers: h, payloadHash, creds, region, service: 's3', now: t });
    const send = Object.assign({}, h);
    delete send.host;                     // fetch sets Host from the URL; the signature already covers it
    send.authorization = 'AWS4-HMAC-SHA256 Credential=' + creds.id + '/' + s.scope
      + ', SignedHeaders=' + s.signedHeaders + ', Signature=' + s.signature;
    return fetchImpl('https://' + host + encPath('/' + key), {
      method, headers: send, body: body || undefined, signal: AbortSignal.timeout(timeoutMs),
    });
  }

  const fail = (what, status) => Object.assign(new Error('S3 ' + what + ' ' + status), { status });

  // { size, type, etag } of an object, or null when it is not there.
  async function head(key) {
    const r = await call('HEAD', key);
    if (r.status === 404 || r.status === 403) return null;     // 403: the user may not list, so a missing key reads as 403
    if (!r.ok) throw fail('HEAD', r.status);
    return { size: Number(r.headers.get('content-length')) || 0, type: r.headers.get('content-type') || '',
             etag: r.headers.get('etag') || '' };
  }
  /* Bytes start..end (inclusive) of an object, as a Buffer. With etag, S3 answers 412 (thrown, .status 412)
     if the object was replaced since: every read of one check sees the same file. */
  async function range(key, start, end, etag) {
    const headers = { range: 'bytes=' + start + '-' + end };
    if (etag) headers['if-match'] = etag;
    const r = await call('GET', key, { headers });
    if (r.status !== 206 && r.status !== 200) throw fail('GET', r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    return r.status === 200 ? buf.subarray(start, end + 1) : buf;
  }
  async function del(key) {
    const r = await call('DELETE', key);
    if (!r.ok && r.status !== 404) throw fail('DELETE', r.status);
    return true;
  }
  /* Copy within the bucket, with the type, caching and file name set fresh (REPLACE): what
     CloudFront serves comes from here, never from what the uploader's browser sent. With
     ifMatch, only if the source is still exactly that version (412 otherwise). */
  async function copy(fromKey, toKey, { contentType, cacheControl, disposition, ifMatch }) {
    const headers = {
      'x-amz-copy-source': '/' + bucket + encPath('/' + fromKey),
      'x-amz-metadata-directive': 'REPLACE',
      'content-type': contentType,
    };
    if (cacheControl) headers['cache-control'] = cacheControl;
    if (disposition) headers['content-disposition'] = disposition;
    if (ifMatch) headers['x-amz-copy-source-if-match'] = ifMatch;
    const r = await call('PUT', toKey, { headers });
    const text = await r.text();
    // A copy can fail AFTER S3 has answered 200: the error is then in the body.
    if (!r.ok || !/<CopyObjectResult/.test(text)) {
      const e = fail('COPY', r.ok ? 500 : r.status);
      e.message += ' ' + ((/<Code>([^<]+)/.exec(text) || [, ''])[1]);
      throw e;
    }
    return true;
  }

  return { presignPut, presignGet, head, range, del, copy, host, bucket };
}

/* CloudFront forgets its copies of these paths (a clip that was taken down). The first
   1,000 paths a month are free; this is one call per take-down. */
async function cloudfrontInvalidate({ distributionId, paths, creds, fetchImpl = globalThis.fetch, now = Date.now }) {
  if (!distributionId || !paths || !paths.length) return false;
  const t = now();
  const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const body = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<InvalidationBatch xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"><Paths><Quantity>' + paths.length
    + '</Quantity><Items>' + paths.map((p) => '<Path>' + xmlEsc(p) + '</Path>').join('') + '</Items></Paths>'
    + '<CallerReference>ds-' + t + '-' + crypto.randomBytes(4).toString('hex') + '</CallerReference></InvalidationBatch>';
  const host = 'cloudfront.amazonaws.com';
  const path = '/2020-05-31/distribution/' + distributionId + '/invalidation';
  const payloadHash = sha256hex(body);
  const { amzDate } = amzDates(t);
  const h = { host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, 'content-type': 'text/xml' };
  const s = sign({ method: 'POST', path, headers: h, payloadHash, creds, region: 'us-east-1', service: 'cloudfront', now: t });
  const send = Object.assign({}, h);
  delete send.host;
  send.authorization = 'AWS4-HMAC-SHA256 Credential=' + creds.id + '/' + s.scope
    + ', SignedHeaders=' + s.signedHeaders + ', Signature=' + s.signature;
  const r = await fetchImpl('https://' + host + path, { method: 'POST', headers: send, body, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('CloudFront invalidation ' + r.status);
  return true;
}

module.exports = { createS3, cloudfrontInvalidate, sign, enc, signingKey };
