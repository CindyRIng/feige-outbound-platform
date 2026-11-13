// 运营对账脚本：根据 audio_assets / transcripts 实际数据修正 calls 流水线状态，并取消堆积作业
// 用法：node scripts/reconcile.mjs [--cancel-jobs]
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
const db = new DatabaseSync(join(homedir(), '.local/share/feige-outbound/fop.db'));
db.exec('PRAGMA foreign_keys=ON');
const now = new Date().toISOString();
let r1 = db.prepare(`UPDATE calls SET audio_status='ready' WHERE audio_status IN ('pending','in_progress','failed') AND EXISTS (SELECT 1 FROM audio_assets a WHERE a.call_id = calls.call_id)`).run();
let r2 = db.prepare(`UPDATE calls SET transcript_status='ready' WHERE transcript_status IN ('pending','in_progress','failed') AND EXISTS (SELECT 1 FROM transcripts t WHERE t.call_id = calls.call_id AND t.is_current = 1)`).run();
let r3 = db.prepare(`UPDATE calls SET analysis_status='ready' WHERE analysis_status IN ('pending','in_progress','failed') AND EXISTS (SELECT 1 FROM analysis_results a WHERE a.call_id = calls.call_id AND a.is_current = 1)`).run();
let r4 = db.prepare(`UPDATE calls SET audio_status='missing', transcript_status='missing', analysis_status='skipped' WHERE status IN ('no_answer','failed','canceled') AND audio_status='pending' AND NOT EXISTS (SELECT 1 FROM audio_assets a WHERE a.call_id = calls.call_id)`).run();
if (process.argv.includes('--cancel-jobs')) {
  const c = db.prepare(`UPDATE jobs SET status='canceled', finished_at=?, next_run_at=NULL WHERE status IN ('queued','running')`).run(now);
  console.log('canceled jobs:', c.changes);
}
console.log('audio->ready:', r1.changes, '| transcript->ready:', r2.changes, '| analysis->ready:', r3.changes, '| no_answer->missing:', r4.changes);
console.log('status dist:', db.prepare('SELECT audio_status, transcript_status, analysis_status, count(*) c FROM calls GROUP BY 1,2,3').all());
db.close();
