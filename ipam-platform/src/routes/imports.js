import fs from 'node:fs';
import { Router } from 'express';
import { db } from '../db.js';
import { wrap, httpError } from './errors.js';
import { authMiddleware, requireCap } from '../domain/authHelpers.js';
import {
  detectFileType, registerBatch, extractRows, autoMapColumns, precheckBatch,
  commitBatch, getBatch, listBatches, batchErrors, batchTraces,
} from '../import/pipeline.js';
import { recordAudit } from '../domain/audit.js';

export const importRouter = Router();
importRouter.use(authMiddleware);

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw httpError(400, '非法的 multipart 请求', 'BAD_MULTIPART');
  const boundary = `--${m[1] || m[2]}`;
  const parts = [];
  let start = buf.indexOf(boundary);
  while (start !== -1) {
    const next = buf.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const chunk = buf.slice(start + boundary.length, next);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = chunk.slice(0, headerEnd).toString('utf8');
      const body = chunk.slice(headerEnd + 4, chunk.length - 2);
      const nameMatch = /name="([^"]*)"/i.exec(headerText);
      const fileMatch = /filename="([^"]*)"/i.exec(headerText);
      parts.push({ name: nameMatch?.[1] || '', filename: fileMatch?.[1] || null, data: body });
    }
    start = next;
  }
  return parts;
}

importRouter.post('/upload', requireCap('import'), (req, res, next) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const buf = Buffer.concat(chunks);
      const parts = parseMultipart(buf, req.headers['content-type']);
      const filePart = parts.find((p) => p.filename);
      const meta = {};
      for (const p of parts) if (!p.filename && p.name) meta[p.name] = p.data.toString('utf8');
      if (!filePart) throw httpError(400, '缺少上传文件');
      const fileType = detectFileType(filePart.filename, filePart.data);
      const batch = registerBatch({
        filename: filePart.filename, buf: filePart.data, fileType, userId: req.user.id,
        sheet: meta.sheet || null,
      });
      if (meta.branch_id) {
        db.prepare('UPDATE import_batches SET branch_id = ? WHERE id = ?').run(Number(meta.branch_id), batch.id);
      }
      recordAudit({
        userId: req.user.id, username: req.user.username, action: 'import.upload',
        entityType: 'import_batch', entityId: batch.id,
        after: { filename: filePart.filename, file_type: fileType }, source: 'web',
      });
      res.status(201).json({ batch_id: batch.id, file_hash: batch.file_hash });
    } catch (e) {
      next(e);
    }
  });
  req.on('error', next);
});

importRouter.get('/batches', requireCap('import'), wrap(async (req, res) => {
  res.json({ batches: listBatches({}) });
}));

importRouter.get('/batches/:id/preview', requireCap('import'), wrap(async (req, res) => {
  const batch = getBatch(Number(req.params.id));
  if (!batch) throw httpError(404, '批次不存在');
  const buf = fs.readFileSync(batch.stored_path);
  const target = req.query.target === 'subnet' ? 'subnet' : 'ip';
  const { sheet, sheets } = extractRows(buf, batch.file_type, batch.sheet);
  const header = sheet.rows[0] || [];
  const mapping = autoMapColumns(header, target);
  const precheck = precheckBatch({ rows: sheet.rows.slice(1, 2001), mapping, target, defaultBranchId: batch.branch_id });
  res.json({
    batch_id: batch.id, filename: batch.filename, file_type: batch.file_type,
    sheets, header, mapping, target,
    counts: precheck.counts,
    sample: precheck.rows.slice(0, 50),
  });
}));

importRouter.post('/batches/:id/commit', requireCap('import'), wrap(async (req, res) => {
  const batch = getBatch(Number(req.params.id));
  if (!batch) throw httpError(404, '批次不存在');
  const target = req.body?.target === 'subnet' ? 'subnet' : 'ip';
  const overwrite = Boolean(req.body?.overwrite);
  const result = commitBatch(batch.id, { target, overwrite });
  recordAudit({
    userId: req.user.id, username: req.user.username, action: 'import.commit',
    entityType: 'import_batch', entityId: batch.id,
    after: { target, overwrite, stats: result.stats, counts: result.counts }, source: 'web',
  });
  res.json(result);
}));

importRouter.get('/batches/:id/errors', requireCap('import'), wrap(async (req, res) => {
  res.json({ errors: batchErrors(Number(req.params.id)) });
}));

importRouter.get('/batches/:id/traces', requireCap('import'), wrap(async (req, res) => {
  res.json({ traces: batchTraces(Number(req.params.id)) });
}));
