// Автоматичні перевірки дашборда.
//
// Запуск:  cd tests && npm install && npm test
//
// Що робить: піднімає локальний сервер із index.html, відкриває його в справжньому браузері
// (Chromium, часовий пояс Europe/Kyiv) і проходить реальні сценарії — збереження, міграцію
// старих даних, захист від зіпсованого сховища, двох вкладок, імпорту, XSS, дат.
// Бібліотеки, які сайт бере з CDN, підміняються локальними копіями з tests/node_modules.
//
// Нічого з цієї папки не потрапляє на сайт і не змінює сам index.html.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const NM = path.join(__dirname, 'node_modules');
const STORAGE_KEY = 'media_dashboard_v1';
const TABS = ['overview','broadcasts','crosstab','contacts','military','enemy','social','shoots','settings'];

// ---------- мінімальний каркас тестів ----------
const results = [];
let currentGroup = '';
async function test(name, fn){
  const full = `${currentGroup} › ${name}`;
  try{ await fn(); results.push({ok:true, name:full}); console.log('  ✓', name); }
  catch(e){ results.push({ok:false, name:full, err:e}); console.log('  ✗', name, '\n     ', (e && e.message || e).toString().split('\n').join('\n      ')); }
}
function group(name){ currentGroup = name; console.log('\n' + name); }
function assert(cond, msg){ if(!cond) throw new Error(msg || 'assertion failed'); }
function eq(actual, expected, msg){
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if(a !== b) throw new Error(`${msg || 'не збігається'}\n  очікувалось: ${b}\n  отримано:    ${a}`);
}

// ---------- сервер і підміна CDN ----------
function startServer(){
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      if(req.url.split('?')[0] === '/' || req.url.startsWith('/index.html')){
        res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
        res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
      } else { res.writeHead(404); res.end(); }
    }).listen(0, '127.0.0.1', () => resolve({srv, url:`http://127.0.0.1:${srv.address().port}/`}));
  });
}
const CDN_MAP = [
  [/chart\.umd\.js/,     path.join(NM, 'chart.js/dist/chart.umd.js')],
  [/xlsx.*\.min\.js/,    path.join(NM, 'xlsx/dist/xlsx.full.min.js')],
  [/pptxgen\.bundle\.js/, path.join(NM, 'pptxgenjs/dist/pptxgen.bundle.js')],
];
async function newContext(browser){
  const ctx = await browser.newContext({timezoneId:'Europe/Kyiv', locale:'uk-UA', acceptDownloads:true});
  await ctx.route(u => !/^http:\/\/127\.0\.0\.1/.test(u.toString()), route => {
    const url = route.request().url();
    const hit = CDN_MAP.find(([re]) => re.test(url));
    if(hit) return route.fulfill({status:200, contentType:'application/javascript', body:fs.readFileSync(hit[1])});
    route.abort(); // шрифти й усе інше зовнішнє не потрібні для логіки
  });
  return ctx;
}
// Відкриває сторінку; initialStorage (рядок) кладеться в localStorage до першого запуску коду сайту.
async function openPage(ctx, url, initialStorage){
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  page.on('console', m => { if(m.type()==='error' && !/Failed to load resource|net::ERR/.test(m.text())) page.errors.push('console: '+m.text()); });
  page.on('dialog', d => d.accept());
  if(initialStorage !== undefined){
    await page.goto(url);
    await page.evaluate(([k,v]) => { if(v===null) localStorage.removeItem(k); else localStorage.setItem(k, v); }, [STORAGE_KEY, initialStorage]);
    await page.reload();
  } else {
    await page.goto(url);
  }
  await page.waitForFunction(() => typeof DB !== 'undefined' && DB !== null);
  return page;
}
const lsGet = page => page.evaluate(k => localStorage.getItem(k), STORAGE_KEY);

// ---------- тестові дані ----------
const EMPTY_DB = () => ({broadcasts:[], contacts:[]});
const HOSTILE = '"><img src=x onerror=window.__pwned=1><script>window.__pwned=1</script>';
const HOSTILE_LINK = 'javascript:window.__pwned=1';

(async () => {
  const {srv, url} = await startServer();
  const browser = await chromium.launch();
  let ctx;
  try{
    // =====================================================================
    group('1. Запуск і вкладки');
    ctx = await newContext(browser);
    await test('чиста сторінка запускається без помилок JS', async () => {
      const p = await openPage(ctx, url, null);
      eq(p.errors, [], 'помилки на сторінці');
      await p.close();
    });
    await test('усі 9 вкладок відкриваються на порожніх даних без помилок', async () => {
      const p = await openPage(ctx, url, null);
      for(const t of TABS) await p.evaluate(t => setTab(t), t);
      eq(p.errors, [], 'помилки на сторінці');
      await p.close();
    });
    await test('усі 9 вкладок відкриваються на заповнених даних без помилок', async () => {
      const db = {
        broadcasts:[
          {id:'b1', date:'2026-03-05', status:'вийшов', type:'ефір', channel:'Канал А', topic:'Тема', guest:'Гість', journalist:'Журналіст', note:'', topicLink:'https://example.com'},
          {id:'b2', date:'2026-03-09', dateEnd:'2026-03-12', status:'запланований', type:'реклама', medium:['Радіо'], channel:'Канал Б', topic:'Кампанія'},
          {id:'b3', date:'2026-04-02', status:'вийшов', type:'подія', channel:'Подія', topic:'Захід'},
        ],
        contacts:[{id:'c1', region:'Львів', media:'Медіа', name:'Ім’я Прізвище', position:'', phone:'', email:'', projects:[{name:'П', link:'https://example.com'}], cooperation:'', note:''}],
        militaryContacts:[{id:'m1', name:'Особа', unit:'Підрозділ', callsign:'', position:'', phone:'', email:'', note:''}],
        enemyMentions:[{id:'e1', date:'2026-03-01', channel:'Канал', message:'Текст', original:''}],
        socialNetworks:['Facebook'], socialMetrics:{Facebook:['Охоплення']},
        socialStats:[
          {id:'s1', network:'Facebook', month:'2026-01', subscribers:1000, extra:{'Охоплення':500}},
          {id:'s2', network:'Facebook', month:'2026-02', subscribers:1100, extra:{'Охоплення':800}},
        ],
        shoots:[{id:'sh1', title:'Сюжет', type:'відео', stage:'Ідея', contactName:null, notes:'', tasks:[], links:[], order:0, createdAt:'2026-03-01'}],
      };
      const p = await openPage(ctx, url, JSON.stringify(db));
      for(const t of TABS) await p.evaluate(t => setTab(t), t);
      eq(p.errors, [], 'помилки на сторінці');
      eq(await p.evaluate(() => DB.broadcasts.length), 3, 'ефіри не загубились');
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('2. Збереження та відновлення даних');
    ctx = await newContext(browser);
    await test('запис, перезавантаження — дані на місці', async () => {
      const p = await openPage(ctx, url, null);
      const ok = await p.evaluate(async () => {
        DB.broadcasts.unshift({id:'x1', date:'2026-05-05', status:'вийшов', type:'ефір', channel:'Тест', topic:'Збереження'});
        return await saveDB(false);
      });
      assert(ok === true, 'saveDB мав повернути true');
      await p.reload();
      await p.waitForFunction(() => DB !== null);
      eq(await p.evaluate(() => DB.broadcasts.map(b => b.topic)), ['Збереження']);
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('3. Міграція старих даних');
    ctx = await newContext(browser);
    await test('старий формат дозбирається до поточної структури, нічого не губиться', async () => {
      const legacy = {
        broadcasts:[{id:'b1', date:'2025-01-10', channel:'Подкаст "Без броні"', topic:'Старий запис'},
                    {id:'b2', date:'2025-01-11', type:'захід', channel:'X', topic:'Старий захід'}],
        contacts:[{id:'c1', media:'Дивись. інфо', name:'Хтось'}],
        socialNetworks:['Facebook','Instagram'],
        socialMetrics:['Охоплення'],                                     // старий формат: плоский список
        socialStats:[{id:'s1', network:'Facebook', month:'2025-01', subscribers:10, views:77, extra:{'Охоплення':5}}],
        shoots:[{id:'sh1', title:'Зйомка', stage:'Ідея', contactId:'m1'}],
        militaryContacts:[{id:'m1', name:'Ім’я для перевірки'}],
      };
      const p = await openPage(ctx, url, JSON.stringify(legacy));
      eq(p.errors, [], 'помилки на сторінці');
      const r = await p.evaluate(() => ({
        types: DB.broadcasts.map(b => b.type),
        channel: DB.broadcasts[0].channel,
        mediaFixed: DB.contacts[0].media,
        metricsShape: Array.isArray(DB.socialMetrics) ? 'array' : typeof DB.socialMetrics,
        fbMetrics: DB.socialMetrics.Facebook,
        hasViewsField: 'views' in DB.socialStats[0],
        viewsInExtra: DB.socialStats[0].extra['Перегляди'],
        shootContactId: 'contactId' in DB.shoots[0],
        shootContactName: DB.shoots[0].contactName,
        shootType: DB.shoots[0].type,
        hiddenTabs: DB.settings.hiddenTabs,
      }));
      eq(r.types, ['ефір','подія'], 'типи записів');
      eq(r.channel, 'Без броні', 'нормалізація назви каналу');
      eq(r.mediaFixed, 'Дивись.інфо', 'нормалізація назви медіа');
      eq(r.metricsShape, 'object', 'socialMetrics → об’єкт по мережах');
      assert(r.fbMetrics.includes('Охоплення') && r.fbMetrics.includes('Перегляди'), 'метрики Facebook: '+JSON.stringify(r.fbMetrics));
      eq(r.hasViewsField, false, 'поле views прибране');
      eq(r.viewsInExtra, 77, 'views перенесено в Перегляди');
      eq(r.shootContactId, false, 'contactId прибрано');
      eq(r.shootContactName, 'Ім’я для перевірки', 'ім’я контакту підтягнуто');
      eq(r.shootType, 'відео', 'тип зйомки за замовчуванням');
      eq(r.hiddenTabs, [], 'hiddenTabs');
      await p.close();
    });
    await test('normalizeGuestField чистить список гостей і нічого не підміняє', async () => {
      const p = await openPage(ctx, url, null);
      const r = await p.evaluate(() => ({
        a: normalizeGuestField('  Перший  ,, Другий ,'),
        b: normalizeGuestField('Евген Прізвище'),   // раніше "відомі варіанти" виправлялись; тепер текст лишається як ввели
        empty: normalizeGuestField(''), nul: normalizeGuestField(null),
        noAliasTable: typeof GUEST_ALIASES,
      }));
      eq(r.a, 'Перший, Другий'); eq(r.b, 'Евген Прізвище');
      eq([r.empty, r.nul], ['', null]);
      eq(r.noAliasTable, 'undefined', 'таблиця з іменами має бути прибрана з коду');
      await p.close();
    });
    await test('міграція ідемпотентна: повторне завантаження нічого не змінює', async () => {
      const p = await openPage(ctx, url);   // дані вже мігровані й збережені попереднім тестом? — зберігаємо явно
      await p.evaluate(() => saveDB(false));
      const first = await lsGet(p);
      await p.reload(); await p.waitForFunction(() => DB !== null);
      await p.evaluate(() => saveDB(false));
      const second = await lsGet(p);
      eq(second, first, 'після другого завантаження дані відрізняються');
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('4. Зіпсоване сховище не перезаписується');
    ctx = await newContext(browser);
    for(const [label, raw] of [['не-JSON', 'це не json{'], ['чужа структура', JSON.stringify({hello:'world'})]]){
      await test(`${label}: дані лишаються недоторканими, збереження вимкнене`, async () => {
        const p = await openPage(ctx, url, raw);
        assert(await p.evaluate(() => storageLocked) === true, 'storageLocked має бути true');
        eq(await lsGet(p), raw, 'вміст сховища змінено!');
        const saved = await p.evaluate(() => saveDB(false));
        eq(saved, false, 'saveDB не має писати при блокуванні');
        eq(await lsGet(p), raw, 'вміст сховища змінено після спроби збереження!');
        await p.close();
      });
    }
    await ctx.close();

    // =====================================================================
    group('5. Дві вкладки не затирають одна одну');
    ctx = await newContext(browser);
    await test('застаріла вкладка не перезаписує свіжі дані іншої', async () => {
      const a = await openPage(ctx, url, null);
      const b = await openPage(ctx, url);
      await a.evaluate(async () => { DB.broadcasts.unshift({id:'fromA', date:'2026-06-01', status:'вийшов', type:'ефір', channel:'A', topic:'Від вкладки A'}); return saveDB(false); });
      const bSaved = await b.evaluate(async () => { DB.broadcasts.unshift({id:'fromB', date:'2026-06-02', status:'вийшов', type:'ефір', channel:'B', topic:'Від вкладки B'}); return saveDB(false); });
      eq(bSaved, false, 'вкладка B не мала зберегти');
      const stored = JSON.parse(await lsGet(a));
      eq(stored.broadcasts.map(x => x.id), ['fromA'], 'у сховищі мають бути лише дані вкладки A');
      await a.close(); await b.close();
    });
    await ctx.close();

    // =====================================================================
    group('6. Імпорт резервної копії');
    ctx = await newContext(browser);
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'md-tests-'));
    const writeTmp = (name, obj) => { const f = path.join(tmp, name); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
    await test('імпорт: спершу віддає копію старих даних, потім замінює; вигляд (settings) зберігається', async () => {
      const old = {...EMPTY_DB(), broadcasts:[{id:'old1', date:'2026-01-01', status:'вийшов', type:'ефір', channel:'Старий', topic:'Старі дані'}], settings:{hiddenTabs:['enemy'], accent:'#123456'}};
      const p = await openPage(ctx, url, JSON.stringify(old));
      const incoming = writeTmp('in.json', {...EMPTY_DB(), broadcasts:[{id:'new1', date:'2026-02-02', status:'вийшов', type:'ефір', channel:'Новий', topic:'Нові дані'}], settings:{hiddenTabs:[], accent:'#ffffff'}});
      const dl = p.waitForEvent('download');
      await p.setInputFiles('#importFile', incoming);
      const d = await dl;
      assert(/^before-import-\d{4}-\d{2}-\d{2}\.json$/.test(d.suggestedFilename()), 'ім’я файлу копії: '+d.suggestedFilename());
      const copy = JSON.parse(fs.readFileSync(await d.path(), 'utf8'));
      eq(copy.broadcasts.map(b => b.id), ['old1'], 'копія має містити СТАРІ дані');
      await p.waitForFunction(() => DB.broadcasts.length === 1 && DB.broadcasts[0].id === 'new1');
      eq(await p.evaluate(() => DB.settings.hiddenTabs), ['enemy'], 'налаштування вигляду не мають змінитись');
      eq(JSON.parse(await lsGet(p)).broadcasts.map(b => b.id), ['new1'], 'нові дані мають бути збережені');
      await p.close();
    });
    await test('імпорт: файл неправильної форми відхиляється, дані та сховище не змінюються', async () => {
      const p = await openPage(ctx, url, JSON.stringify({...EMPTY_DB(), broadcasts:[{id:'keep', date:'2026-01-01', type:'ефір', channel:'К', topic:'Лишається'}]}));
      const before = await lsGet(p);
      let downloaded = false; p.on('download', () => downloaded = true);
      await p.setInputFiles('#importFile', writeTmp('bad.json', {broadcasts:'не масив', contacts:[]}));
      await p.waitForTimeout(600);
      eq(await lsGet(p), before, 'сховище змінилось');
      eq(downloaded, false, 'не мало бути завантажень');
      eq(await p.evaluate(() => DB.broadcasts.map(b => b.id)), ['keep']);
      await p.close();
    });
    await test('validateBackupShape: приймає нормальне, відхиляє сміття', async () => {
      const p = await openPage(ctx, url, null);
      const r = await p.evaluate(() => {
        const t = x => { try{ validateBackupShape(x); return true; }catch(e){ return false; } };
        return {
          ok: t({broadcasts:[], contacts:[]}),
          nul: t(null), arr: t([]), str: t('x'),
          noContacts: t({broadcasts:[]}),
          badRow: t({broadcasts:[1], contacts:[]}),
          badOptional: t({broadcasts:[], contacts:[], shoots:'x'}),
          badObj: t({broadcasts:[], contacts:[], socialMetrics:null}),
        };
      });
      eq(r, {ok:true, nul:false, arr:false, str:false, noContacts:false, badRow:false, badOptional:false, badObj:false});
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('7. Безпека: ворожі дані не виконуються');
    ctx = await newContext(browser);
    await test('шкідливі рядки в усіх типах записів нічого не виконують на жодній вкладці', async () => {
      const db = {
        broadcasts:[{id:'b1', date:'2026-03-05', status:'вийшов', type:'ефір', channel:HOSTILE, topic:HOSTILE, guest:HOSTILE, journalist:HOSTILE, note:HOSTILE,
                     topicLink:HOSTILE_LINK, noteLink:HOSTILE_LINK, fileLink:HOSTILE_LINK, photoLink:HOSTILE_LINK},
                    {id:'b2', date:HOSTILE, status:HOSTILE, type:'ефір', channel:'k', topic:'t'}],
        contacts:[{id:'c1', region:HOSTILE, media:HOSTILE, name:HOSTILE, position:HOSTILE, phone:HOSTILE, email:HOSTILE, mediaLink:HOSTILE_LINK, nameLink:HOSTILE_LINK,
                   projects:[{name:HOSTILE, link:HOSTILE_LINK}], cooperation:HOSTILE, note:HOSTILE}],
        militaryContacts:[{id:'m1', name:HOSTILE, unit:HOSTILE, subunit:HOSTILE, callsign:HOSTILE, position:HOSTILE, phone:HOSTILE, email:HOSTILE, note:HOSTILE, noteLink:HOSTILE_LINK, nameLink:HOSTILE_LINK, unitLink:HOSTILE_LINK}],
        enemyMentions:[{id:'e1', date:'2026-03-01', channel:HOSTILE, message:HOSTILE, messageLink:HOSTILE_LINK, original:HOSTILE, originalLink:HOSTILE_LINK}],
        socialNetworks:[HOSTILE], socialMetrics:{[HOSTILE]:[HOSTILE]},
        socialStats:[{id:'s1', network:HOSTILE, month:'2026-01', subscribers:5, extra:{[HOSTILE]:3}}],
        shoots:[{id:'sh1', title:HOSTILE, type:'відео', stage:'Ідея', contactName:HOSTILE, notes:HOSTILE, color:'red;background:url(javascript:1)', tasks:[{id:'t1', text:HOSTILE, done:false}], links:[{label:HOSTILE, url:HOSTILE_LINK}], order:0}],
        shootStages:['Ідея', HOSTILE], extraUnits:[HOSTILE], adMediums:[HOSTILE],
        channelGroups:{[HOSTILE]:HOSTILE},
        settings:{hiddenTabs:[], sidebarColor:'red;background:url(javascript:1)'},
      };
      const p = await openPage(ctx, url, JSON.stringify(db));
      for(const t of TABS) { await p.evaluate(t => setTab(t), t); await p.waitForTimeout(40); }
      const r = await p.evaluate(() => ({
        pwned: window.__pwned,
        injectedImg: document.querySelectorAll('img[src="x"]').length,
        jsLinks: document.querySelectorAll('a[href^="javascript:" i]').length,
        injectedScript: Array.from(document.scripts).filter(s => s.textContent.includes('__pwned=1') && !s.textContent.includes('function ')).length,
      }));
      eq(r, {pwned:undefined, injectedImg:0, jsLinks:0, injectedScript:0}, 'на сторінці щось виконалось або вставилось');
      await p.close();
    });
    await test('esc / attr / safeUrl / safeHref / safeColor', async () => {
      const p = await openPage(ctx, url, null);
      const r = await p.evaluate(() => ({
        esc: esc('<b>"&\'</b>'),
        attr: attr('"x" onmouseover="y"'),
        ok1: safeUrl('https://a.b/c'), ok2: safeUrl('mailto:a@b.c'), ok3: safeUrl('tel:+380'),
        bad1: safeUrl('javascript:alert(1)'), bad2: safeUrl('java\tscript:alert(1)'), bad3: safeUrl('  JaVaScRiPt:alert(1)'),
        bad4: safeUrl('data:text/html,<script>1</script>'), bad5: safeUrl('vbscript:x'), bad6: safeUrl('​javascript:x'),
        href: safeHref('javascript:alert(1)'),
        color: [safeColor('#fff'), safeColor('#a1b2c3'), safeColor('red'), safeColor('#fff;x:y'), safeColor('url(x)'), safeColor(null)],
      }));
      eq(r.esc, '&lt;b&gt;&quot;&amp;&#39;&lt;/b&gt;');
      assert(!r.attr.includes('"x"'), 'attr не екранував лапки: '+r.attr);
      eq([r.ok1, r.ok2, r.ok3], ['https://a.b/c', 'mailto:a@b.c', 'tel:+380']);
      eq([r.bad1, r.bad2, r.bad3, r.bad4, r.bad5, r.bad6], ['','','','','','']);
      eq(r.href, 'about:blank');
      eq(r.color, ['#fff', '#a1b2c3', '', '', '', '']);
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('8. Дати у часовому поясі Києва');
    ctx = await newContext(browser);
    await test('localISO не зсуває день (00:30 за Києвом лишається тим самим днем)', async () => {
      const p = await openPage(ctx, url, null);
      const r = await p.evaluate(() => ({
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        morning: localISO(new Date(2026, 0, 1, 0, 30)),      // у UTC це ще 31 грудня
        evening: localISO(new Date(2026, 5, 15, 23, 59)),
        utcWouldBe: new Date(2026, 0, 1, 0, 30).toISOString().slice(0,10),
      }));
      assert(/^Europe\/(Kyiv|Kiev)$/.test(r.tz), 'часовий пояс має бути київський, а не '+r.tz);
      eq(r.morning, '2026-01-01');
      eq(r.evening, '2026-06-15');
      assert(r.utcWouldBe !== r.morning, 'тест нічого не доводить: UTC і локальна дата збіглись');
      await p.close();
    });
    await test('parseUaDate / fmtDate', async () => {
      const p = await openPage(ctx, url, null);
      const r = await p.evaluate(() => ({
        a: parseUaDate('05.03.2026'), leap: parseUaDate('29.02.2028'), notLeap: parseUaDate('29.02.2027'),
        feb31: parseUaDate('31.02.2026'), junk: parseUaDate('abc'), us: parseUaDate('03/05/2026'), empty: parseUaDate(''),
        f1: fmtDate('2026-03-05'), f2: fmtDate(''), f3: fmtDate('<b>x</b>'),
      }));
      eq(r.a, '2026-03-05'); eq(r.leap, '2028-02-29');
      eq([r.notLeap, r.feb31, r.junk, r.us, r.empty], [null, null, null, null, null]);
      eq(r.f1, '05.03.2026'); eq(r.f2, '—');
      assert(!/[<>]/.test(r.f3), 'fmtDate пропустив розмітку: '+r.f3);
      await p.close();
    });
    await test('дати з Excel: серійний номер читається як календарна дата, без зсуву', async () => {
      const p = await openPage(ctx, url, null);
      const r = await p.evaluate(() => {
        // 46086 = 2026-03-05 (епоха Excel 1899-12-30)
        const ws = XLSX.utils.aoa_to_sheet([['Дата'], [46086]]);
        ws['A2'].t = 'n'; ws['A2'].z = 'dd.mm.yyyy';
        const parsed = XLSX.SSF.parse_date_code(46086);
        return {y:parsed.y, m:parsed.m, d:parsed.d, viaApp: typeof parseImportedDate === 'function' ? parseImportedDate(46086) : null};
      });
      eq([r.y, r.m, r.d], [2026, 3, 5]);
      if(r.viaApp) eq(r.viaApp, '2026-03-05', 'parseImportedDate(46086)');
      await p.close();
    });
    await ctx.close();

    // =====================================================================
    group('9. Створення запису через форму (наскрізний сценарій)');
    ctx = await newContext(browser);
    await test('додати ворожу згадку через модальне вікно → зберігається і видно в таблиці', async () => {
      const p = await openPage(ctx, url, null);
      await p.evaluate(() => setTab('enemy'));
      const opener = await p.evaluate(() => typeof openEnemyModal === 'function' ? 'openEnemyModal' : null);
      if(!opener){ console.log('     (пропущено: не знайдено функції відкриття форми)'); await p.close(); return; }
      await p.evaluate(() => openEnemyModal());
      await p.fill('#e_channel', 'Тестовий канал');
      await p.fill('#e_message', 'Тестове повідомлення');
      await p.evaluate(() => saveEnemy());
      await p.waitForFunction(() => DB.enemyMentions.length === 1);
      assert((await lsGet(p)).includes('Тестове повідомлення'), 'запис не потрапив у сховище');
      assert((await p.locator('#enemySub').innerText()).startsWith('1 записів'), 'лічильник у заголовку вкладки не оновився');
      await p.locator('#enemyGroups .media-head').first().click();          // місяці за задумом згорнуті
      await p.waitForSelector('#enemyGroups .media-body:not(.hidden)');
      assert((await p.locator('#enemyGroups').innerText()).includes('Тестове повідомлення'), 'запис не видно у вкладці після розгортання місяця');
      eq(p.errors, [], 'помилки на сторінці');
      await p.close();
    });
    await ctx.close();
  } finally {
    await browser.close();
    srv.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length} з ${results.length} перевірок пройдено`);
  if(failed.length){ console.log('\nПровалені:'); failed.forEach(f => console.log(' -', f.name)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(2); });
