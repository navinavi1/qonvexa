import path from 'node:path';

export class ArtifactStore {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.client = null;
    this.bucket = String(env.S3_BUCKET || '').trim();
  }

  configured() {
    return Boolean(this.bucket && this.env.S3_ENDPOINT && this.env.S3_ACCESS_KEY_ID && this.env.S3_SECRET_ACCESS_KEY);
  }

  async init() {
    if (!this.configured()) return { ok:false, reason:'s3_not_configured' };
    try {
      const { S3Client } = await import('@aws-sdk/client-s3');
      this.client = new S3Client({
        endpoint:String(this.env.S3_ENDPOINT),
        region:String(this.env.S3_REGION || 'auto'),
        forcePathStyle:/^(1|true|yes)$/i.test(String(this.env.S3_FORCE_PATH_STYLE || '')),
        credentials:{
          accessKeyId:String(this.env.S3_ACCESS_KEY_ID),
          secretAccessKey:String(this.env.S3_SECRET_ACCESS_KEY)
        }
      });
      return { ok:true };
    } catch (error) {
      return { ok:false, reason:String(error?.message || error) };
    }
  }

  async ensureReady() {
    if (this.client) return { ok:true };
    return this.init();
  }

  async putText(key, content, contentType = 'text/plain; charset=utf-8') {
    return this.putBuffer(key, Buffer.from(String(content ?? ''), 'utf8'), contentType);
  }

  async putJson(key, value) {
    return this.putText(key, JSON.stringify(value, null, 2), 'application/json; charset=utf-8');
  }

  async putBuffer(key, content, contentType = 'application/octet-stream') {
    const ready = await this.ensureReady();
    if (!ready.ok) return { ok:false, reason:ready.reason || 's3_not_ready' };
    const cleanKey = safeKey(key);
    if (!cleanKey) return { ok:false, reason:'invalid_artifact_key' };
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content ?? '');
    const maxBytes = Math.max(1, Number(this.env.AUTONOMOS_ARTIFACT_MAX_BYTES || 25 * 1024 * 1024));
    if (body.length > maxBytes) return { ok:false, reason:`artifact_too_large:${body.length}>${maxBytes}` };
    try {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      await this.client.send(new PutObjectCommand({ Bucket:this.bucket, Key:cleanKey, Body:body, ContentType:String(contentType || 'application/octet-stream') }));
      const access = await this.getDownloadUrl(cleanKey);
      return { ok:true, bucket:this.bucket, key:cleanKey, bytes:body.length, contentType, url:access.url || '', urlExpiresInSeconds:access.expiresInSeconds || null };
    } catch (error) {
      return { ok:false, reason:String(error?.message || error).slice(0,300) };
    }
  }

  async getDownloadUrl(key) {
    const cleanKey = safeKey(key);
    if (!cleanKey) return { ok:false, reason:'invalid_artifact_key' };
    const publicBase = String(this.env.S3_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
    if (publicBase) return { ok:true, url:`${publicBase}/${cleanKey.split('/').map(encodeURIComponent).join('/')}`, public:true };
    const ready = await this.ensureReady();
    if (!ready.ok) return { ok:false, reason:ready.reason || 's3_not_ready' };
    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      // Default raised from 24h to the AWS-imposed 7-day ceiling for presigned URLs (a
      // hard SigV4 protocol limit, not something this code can extend further) — some
      // marketplaces (Superteam Earn) can take days-to-weeks to review a submission, and
      // a 24-hour link would already be dead long before anyone looks at it. For a link
      // that never expires, set S3_PUBLIC_BASE_URL instead (preferred above, when set).
      const expiresIn = Math.max(60, Math.min(7 * 86400, Number(this.env.AUTONOMOS_ARTIFACT_URL_TTL_SECONDS || 7 * 86400)));
      const url = await getSignedUrl(this.client, new GetObjectCommand({ Bucket:this.bucket, Key:cleanKey }), { expiresIn });
      return { ok:true, url, public:false, expiresInSeconds:expiresIn };
    } catch (error) {
      return { ok:false, reason:String(error?.message || error).slice(0,300) };
    }
  }
}

function safeKey(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.includes('..') || raw.includes('\0')) return '';
  const normalized = path.posix.normalize(raw);
  if (normalized.startsWith('../') || normalized === '..') return '';
  return normalized.replace(/[^a-zA-Z0-9._\-/]/g, '_').slice(0, 900);
}
