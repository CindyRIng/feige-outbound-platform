#!/usr/bin/env node
// 飞鸽外呼自动登录 worker（纯 JS；必须在 cloak-run FHS 内运行：~/cloak-env/bin/cloak-run node <this> <credFile>）
//
// 流程（docs/09 §6.4–§6.7 / docs/00 §2）：
//   打开 https://feige.duofangtongxin.com/#/login → 填手机号/密码 → 拖动阿里云滑块（humanized 轨迹）
//   → 点击登录 → 捕获 POST /sso/login 响应 → 提取 JWT（响应 data / CLOUD_TOKEN cookie / localStorage）
//   → stdout 输出单行 JSON {ok,jwt,jwtExpiresAt,jwtIssuedAt}；失败输出 {ok:false,reason,errorDetail}
// 安全：credentials 从 0600 临时文件读取后立即删除；密码/JWT/captchaVerifyParam 不打印。
import { readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { launchPersistentContext } from 'cloakbrowser';

const LOGIN_URL_DEFAULT = 'https://feige.duofangtongxin.com/#/login';
const HOME_URL_RE = /#\/menu\/home/;
const JWT_RE = /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}$/;
const MAX_ATTEMPTS = 3; // 首次 + 失败重试 2 次
const SLIDER_TRIES_PER_ATTEMPT = 2;

const credPath = process.argv[2];
let cred = null;
try {
  cred = JSON.parse(readFileSync(credPath, 'utf8'));
} catch (e) {
  out({ ok: false, reason: 'CREDENTIALS_UNAVAILABLE', errorDetail: `读取临时凭证失败: ${e.message}` });
  process.exit(2);
} finally {
  try { unlinkSync(credPath); } catch { /* ignore */ }
}

const timeoutMs = Number(cred.timeoutMs) > 0 ? Number(cred.timeoutMs) : 180000;
const loginUrl = cred.loginUrl || LOGIN_URL_DEFAULT;
const profileDir = cred.profileDir;
const headless = cred.headless === true;
const diagnosticsDir = cred.diagnosticsDir;

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  process.stderr.write(`[login-worker] ${redact(line)}\n`);
}

function redact(text) {
  return String(text ?? '')
    .replace(/1[3-9]\d{9}/g, (m) => `${m.slice(0, 3)}****${m.slice(-4)}`)
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '***JWT***')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
    .replace(/"password"\s*:\s*"[^"]*"/g, '"password":"***"');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function decodeJwt(jwt) {
  try {
    const parts = jwt.split('.');
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isJwtLike(value) {
  return typeof value === 'string' && JWT_RE.test(value.trim());
}

function pickValidJwt(candidates) {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const raw of candidates) {
    if (!isJwtLike(raw)) continue;
    const jwt = raw.trim();
    const payload = decodeJwt(jwt);
    if (payload && typeof payload.exp === 'number' && payload.exp > nowSec + 60) return { jwt, payload };
  }
  return null;
}

function classifyMessage(message) {
  const msg = String(message || '');
  if (/密码|账号|用户名/.test(msg)) return 'BAD_CREDENTIALS';
  if (/验证码|滑块|风控|风险/.test(msg)) return 'CAPTCHA_FAILED';
  if (/二次验证|改密/.test(msg)) return 'SECONDARY_AUTH_REQUIRED';
  return 'LOGIN_FAILED';
}

async function findFirstVisible(page, selectors, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try {
        if (await loc.isVisible().catch(() => false)) return loc;
      } catch { /* ignore */ }
    }
    await sleep(200);
  }
  return null;
}

async function fillCredentials(page) {
  // 部分前端默认展示二维码/短信登录，需先切到密码登录
  const pwdVisible = await findFirstVisible(page, ['input[type="password"]'], 1500);
  if (!pwdVisible) {
    for (const t of ['密码登录', '账号密码登录', '账号登录']) {
      const tab = page.getByText(t, { exact: false }).first();
      if (await tab.isVisible().catch(() => false)) {
        await tab.click({ timeout: 3000 }).catch(() => undefined);
        break;
      }
    }
  }
  const phoneInput = await findFirstVisible(
    page,
    [
      'input[type="tel"]',
      'input[placeholder*="手机号"]',
      'input[placeholder*="手机"]',
      'input[placeholder*="账号"]',
      'form input:not([type="password"])',
    ],
    10000,
  );
  const pwdInput = await findFirstVisible(page, ['input[type="password"]'], 10000);
  if (!phoneInput || !pwdInput) throw new Error('未找到手机号/密码输入框（登录页可能改版）');
  await phoneInput.click({ timeout: 3000 }).catch(() => undefined);
  await phoneInput.fill('');
  await phoneInput.type(cred.username, { delay: 25 });
  await pwdInput.click({ timeout: 3000 }).catch(() => undefined);
  await pwdInput.fill('');
  await pwdInput.type(cred.password, { delay: 25 });
  return true;
}

async function ensureAgreementAccepted(page) {
  // 登录页有「同意《用户协议》和《隐私协议》」复选框，未勾选时前端会拦截登录请求
  const checkbox = page.locator('input.el-checkbox__original[type="checkbox"]').first();
  try {
    if (await checkbox.isChecked()) return true;
  } catch { /* ignore */ }
  const label = page.locator('.el-checkbox').first();
  if (await label.isVisible().catch(() => false)) await label.click({ timeout: 3000 }).catch(() => undefined);
  else {
    await page
      .evaluate(() => {
        const cb = document.querySelector('input.el-checkbox__original[type="checkbox"]');
        if (cb) cb.click();
      })
      .catch(() => undefined);
  }
  await sleep(150);
  const checked = await checkbox.isChecked().catch(() => false);
  log('agreement checkbox', { checked });
  return checked;
}

async function captchaWrapperState(page) {
  return await page.evaluate(() => {
    const w = document.querySelector('#aliyunCaptcha-sliding-wrapper');
    const txt = document.body ? document.body.innerText : '';
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    return { visible: visible(w), passed: /验证通过/.test(txt), text: txt.slice(0, 300) };
  }).catch(() => ({ visible: false, passed: false, text: '' }));
}

async function humanizedDrag(page, from, dx) {
  const sx = from.x + from.width / 2;
  const sy = from.y + from.height / 2;
  const steps = 30 + Math.floor(Math.random() * 13); // 30–42 步
  const totalMs = 700 + Math.floor(Math.random() * 401); // 700–1100ms
  const jitterY = () => (Math.random() - 0.5) * 4; // ±2px
  await page.mouse.move(sx, sy, { steps: 8 });
  await sleep(120 + Math.random() * 120);
  await page.mouse.down();
  await sleep(70 + Math.random() * 120);
  let lastX = sx;
  let lastY = sy;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // ease-out（先快后慢），末段微量回正
    const eased = 1 - Math.pow(1 - t, 3);
    const x = sx + dx * eased;
    const y = sy + Math.sin(t * Math.PI * 3) * 1.2 + jitterY();
    lastX = x;
    lastY = y;
    await page.mouse.move(x, y, { steps: 1 });
    await sleep(Math.max(3, Math.round(totalMs / steps + (Math.random() - 0.5) * 8)));
  }
  // 末端 1–2px 回正 + 停顿后释放
  await page.mouse.move(lastX - (1 + Math.random() * 1), lastY, { steps: 2 });
  await sleep(80 + Math.random() * 120);
  await page.mouse.up();
}

async function solveCaptcha(page) {
  const state = await captchaWrapperState(page);
  if (!state.visible) return { attempted: false, passed: state.passed };
  const wrapper = page.locator('#aliyunCaptcha-sliding-wrapper').first();
  const slider = page.locator('#aliyunCaptcha-sliding-slider').first();
  for (let i = 0; i < SLIDER_TRIES_PER_ATTEMPT; i++) {
    const wBox = await wrapper.boundingBox().catch(() => null);
    const sBox = await slider.boundingBox().catch(() => null);
    if (!wBox || !sBox) {
      log('captcha boxes not found', { hasWrapper: !!wBox, hasSlider: !!sBox });
      await sleep(500);
      continue;
    }
    const dx = Math.max(10, wBox.x + wBox.width - sBox.width - sBox.x);
    log('drag slider', { attempt: i + 1, dx: Math.round(dx) });
    await humanizedDrag(page, sBox, dx);
    // 等待验证通过（或滑块消失）
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const st = await captchaWrapperState(page);
      if (st.passed || !st.visible) return { attempted: true, passed: true };
      await sleep(300);
    }
    log('captcha not passed', { attempt: i + 1 });
    await sleep(400);
  }
  return { attempted: true, passed: false };
}

async function extractJwtCandidates(page, context, responseData) {
  const candidates = [];
  if (typeof responseData === 'string') candidates.push(responseData);
  if (responseData && typeof responseData === 'object') {
    for (const key of ['data', 'token', 'jwt', 'accessToken']) {
      const v = responseData[key];
      if (typeof v === 'string') candidates.push(v);
    }
  }
  const pageValues = await page
    .evaluate(() => {
      const values = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = k ? localStorage.getItem(k) : null;
          if (v) values.push(v);
        }
      } catch { /* ignore */ }
      try { values.push(document.cookie || ''); } catch { /* ignore */ }
      return values;
    })
    .catch(() => []);
  for (const v of pageValues) candidates.push(...String(v).split(/[;\s]+/));
  try {
    const cookies = await context.cookies();
    for (const c of cookies) {
      if (c && typeof c.value === 'string') candidates.push(c.value);
    }
  } catch { /* ignore */ }
  return candidates;
}

async function attemptLogin(context, page, attemptNo) {
  log('login attempt', { attemptNo });
  if (page.isClosed()) page = await context.newPage();
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => log('goto warn', e.message));
  await sleep(2500 + Math.random() * 1500);

  // profile 会话可复用：已有有效 CLOUD_TOKEN/JWT 直接成功
  let existing = pickValidJwt(await extractJwtCandidates(page, context, null));
  if (existing) return { ok: true, jwt: existing.jwt, payload: existing.payload, reusedSession: true };

  // 兼容“页面仍处于登录态但本地提取不到有效 JWT”（JWT 过期/存储变化）：清理会话后强制重新登录
  const loggedInPage = await page
    .evaluate(() => {
      try {
        const hash = String(location.hash || '');
        const hasPasswordInput = !!document.querySelector('input[type=password]');
        return /menu|home|dashboard/i.test(hash) || (!hasPasswordInput && !!document.querySelector('.el-menu, .sidebar, .layout-header'));
      } catch { return false; }
    })
    .catch(() => false);
  if (loggedInPage) {
    log('session present but no valid jwt extracted; forcing fresh login');
    await context.clearCookies().catch(() => undefined);
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } }).catch(() => undefined);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => log('re-goto warn', e.message));
    await sleep(2500 + Math.random() * 1500);
  }

  await fillCredentials(page);
  const agreed = await ensureAgreementAccepted(page);
  if (!agreed) log('agreement checkbox not accepted; login may be blocked');
  const captcha = await solveCaptcha(page);
  if (captcha.attempted && !captcha.passed) {
    return { ok: false, reason: 'CAPTCHA_FAILED', needHuman: attemptNo >= MAX_ATTEMPTS, page };
  }

  const responsePromise = page
    .waitForResponse((resp) => resp.url().includes('/sso/login') && resp.request().method() === 'POST', { timeout: 20000 })
    .catch(() => null);
  const loginBtn = await findFirstVisible(
    page,
    ['button:has-text("登录")', 'button[type="submit"]', 'button:has-text("登 录")'],
    6000,
  );
  if (!loginBtn) return { ok: false, reason: 'PAGE_CHANGED', errorDetail: '未找到登录按钮', page };
  await loginBtn.click({ timeout: 5000 }).catch(() => undefined);

  const response = await responsePromise;
  if (!response) {
    const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    if (/同意|协议/.test(bodyText) && /勾选|请阅读|请先/.test(bodyText)) {
      return { ok: false, reason: 'AGREEMENT_REQUIRED', needHuman: true, errorDetail: '未勾选用户协议导致登录请求未发出', page };
    }
    return { ok: false, reason: 'PAGE_LOAD_TIMEOUT', errorDetail: '未捕获到 /sso/login 响应', page };
  }
  const status = response.status();
  let data = null;
  try { data = await response.json(); } catch {
    const text = await response.text().catch(() => '');
    log('login response not JSON', { status, body: text.slice(0, 300) });
  }
  const code = data && typeof data === 'object' ? Number(data.code) : NaN;
  const message = data && typeof data === 'object' ? String(data.message ?? data.msg ?? '') : '';
  if (status === 200 && code === 200) {
    // 等待前端跳转（可选加速；不阻塞成功判定）
    await page.waitForURL(HOME_URL_RE, { timeout: 8000 }).catch(() => undefined);
    const candidate = pickValidJwt(await extractJwtCandidates(page, context, data));
    if (candidate) return { ok: true, jwt: candidate.jwt, payload: candidate.payload };
    return { ok: false, reason: 'INVALID_JWT', errorDetail: '登录成功但未提取到有效 JWT', page };
  }
  if (code === 206) {
    return { ok: false, reason: 'SECONDARY_AUTH_REQUIRED', needHuman: true, errorDetail: message || '需要二次验证/改密', page };
  }
  return { ok: false, reason: classifyMessage(message), needHuman: true, errorDetail: message.slice(0, 200), page };
}

async function saveDiagnostics(page) {
  if (!diagnosticsDir) return;
  try {
    mkdirSync(diagnosticsDir, { recursive: true, mode: 0o700 });
    const file = join(diagnosticsDir, `login-fail-${Date.now()}.png`);
    await page.screenshot({ path: file }).catch(() => undefined);
    log('screenshot saved', { file });
  } catch { /* ignore */ }
}

async function main() {
  log('boot', { headless, profileDir, display: process.env.DISPLAY });
  let context = null;
  let page = null;
  try {
    context = await launchPersistentContext({
      userDataDir: profileDir,
      headless,
      humanize: true,
      timezone: 'Asia/Shanghai',
      locale: 'zh-CN',
      viewport: { width: 1440, height: 900 },
      args: ['--start-maximized'],
    });
    context.on('page', () => undefined);
    page = context.pages()[0] || (await context.newPage());
    let lastFailure = { ok: false, reason: 'LOGIN_FAILED' };
    for (let attemptNo = 1; attemptNo <= MAX_ATTEMPTS; attemptNo++) {
      if (attemptNo > 1) await sleep(1500 * attemptNo);
      const result = await attemptLogin(context, page, attemptNo).catch((e) => ({
        ok: false,
        reason: 'LOGIN_FAILED',
        errorDetail: `attempt error: ${e.message}`,
        page,
      }));
      page = result.page || page;
      if (result.ok) {
        const payload = result.payload || {};
        const exp = typeof payload.exp === 'number' ? payload.exp : null;
        const iat = typeof payload.iat === 'number' ? payload.iat : null;
        out({
          ok: true,
          jwt: result.jwt,
          jwtExpiresAt: exp ? new Date(exp * 1000).toISOString() : undefined,
          jwtIssuedAt: iat ? new Date(iat * 1000).toISOString() : undefined,
          reason: result.reusedSession ? 'PROFILE_REUSED' : 'LOGIN_OK',
        });
        return 0;
      }
      lastFailure = { ok: false, reason: result.reason || 'LOGIN_FAILED', errorDetail: result.errorDetail, needHuman: result.needHuman };
      log('login attempt failed', { attemptNo, reason: lastFailure.reason });
      // 凭证错误/二次验证不继续重试
      if (lastFailure.reason === 'BAD_CREDENTIALS' || lastFailure.reason === 'SECONDARY_AUTH_REQUIRED') break;
    }
    if (page && !page.isClosed()) await saveDiagnostics(page);
    out(lastFailure);
    return 1;
  } catch (e) {
    out({ ok: false, reason: 'BROWSER_LAUNCH_FAILED', errorDetail: redact(e.message) });
    return 2;
  } finally {
    try { if (context) await context.close(); } catch { /* ignore */ }
  }
}

// 全局看门狗：避免浏览器/页面卡死导致父进程超时无结果
const watchdog = setTimeout(() => {
  out({ ok: false, reason: 'LOGIN_TIMEOUT', errorDetail: `worker 超时（${timeoutMs}ms）` });
  process.exit(3);
}, timeoutMs);
watchdog.unref?.();

main()
  .then((code) => { clearTimeout(watchdog); process.exit(code || 0); })
  .catch((e) => {
    clearTimeout(watchdog);
    out({ ok: false, reason: 'WORKER_ERROR', errorDetail: redact(e.message) });
    process.exit(1);
  });
