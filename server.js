// ============================================================
// EduCore Backend — AI-ядро + адаптивный движок + curriculum API
// Запуск: npm install && node server.js
// Секреты ТОЛЬКО в .env (никогда не попадают во frontend)
// ============================================================
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const {CURRICULUM, TOPIC_INDEX} = require('./data/curriculum');

const app = express();
app.use(express.json({limit:'15mb'}));
app.use(express.static(path.join(__dirname,'public')));

const PORT = process.env.PORT || 3000;
const AI_KEY = process.env.OPENAI_API_KEY || '';
const AI_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions';
const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ---------------- Хранилище профиля ученика (JSON-файл;
// в проде заменяется на PostgreSQL/Mongo без смены API) ----------------
const STORE = path.join(__dirname,'students','default.json');
function loadStudent(){
  try { return JSON.parse(fs.readFileSync(STORE,'utf8')); } catch(e){
    return {id:'default', name:'Алина', topics:{}, history:[]};
  }
}
function saveStudent(s){ fs.writeFileSync(STORE, JSON.stringify(s,null,1)); }
function topicState(st, id){
  if(!st.topics[id]) st.topics[id] = {mastery:0, attempts:0, correct:0, streak:0, difficulty:1, lastMistake:null, updatedAt:null};
  return st.topics[id];
}

// ---------------- Генератор заданий (локальное ядро, работает без AI-ключа) ----------------
function genTask(topic, difficulty){
  const d = difficulty || 1;
  const n = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;
  // Числовые генераторы по ключевым словам темы
  const t = topic.name.toLowerCase();
  if(/вычитан|сложени/.test(t)&&topic.grade<=3){
    const a=n(10,50),b=n(5,40);return{q:`${a} + ${b} = ?`,answer:a+b,hint:'Складывай по разрядам: сначала единицы, потом десятки.'};
  }
  if(/умножени|табличное/.test(t)&&topic.grade<=4){
    const a=n(2,9),b=n(2,9);return{q:`${a} × ${b} = ?`,answer:a*b,hint:`Вспомни таблицу умножения: ${a} × ${b}.`};
  }
  if(/деление с остатком/.test(t)){
    const a=n(20,99),b=n(3,9),q=Math.floor(a/b),r=a%b;return{q:`${a} : ${b} = ? (запиши ответ как "частное, остаток")`,answer:`${q}, ${r}`,hint:`${b} × ${q} = ${b*q}, остаток ${r}.`};
  }
  if(/уравнен|уравнения/.test(t)&&/линейн/.test(t)){
    const a=n(2,9),x=n(2,12),b=n(1,15);return{q:`Реши уравнение: ${a}x + ${b} = ${a*x+b}. x = ?`,answer:x,hint:`Перенеси ${b} вправо с противоположным знаком, затем раздели на ${a}.`};
  }
  if(/процент/.test(t)){
    const p=[10,20,25,50][n(0,3)],a=n(40,400),ans=p===25?a/4:p===10?a/10:p===20?a/5:a/2;return{q:`${p}% от ${a} = ?`,answer:ans,hint:`${p}% — это ${p}/100. Умножь ${a} на ${p} и раздели на 100.`};
  }
  if(/квадратн/.test(t)&&/уравнен/.test(t)){
    const x1=n(-6,6),x2=n(-6,6),b=-(x1+x2),c=x1*x2;
    const s=b>=0?`+ ${b}x`:`- ${Math.abs(b)}x`, sc=c>=0?`+ ${c}`:`- ${Math.abs(c)}`;
    return{q:`Реши уравнение: x² ${s} ${sc} = 0. Введи больший корень.`,answer:Math.max(x1,x2),hint:`Проверь по Виету: сумма корней = ${-b}, произведение = ${c}.`};
  }
  if(/производн|дифференцир/.test(t)){
    const a=n(2,5),k=n(2,4);return{q:`Найди производную: f(x) = ${a}x^${k}. f'(x) = ? (запиши как "ax^k", напр. 8x^3)`,answer:`${a*k}x^${k-1}`,hint:`Правило степени: (x^n)' = n·x^(n−1).`};
  }
  if(/логарифм/.test(t)){
    const b=n(2,5),k=n(2,4);return{q:`Вычисли: log_${b}(${Math.pow(b,k)}) = ?`,answer:k,hint:`Спроси себя: в какую степень нужно возвести ${b}, чтобы получить ${Math.pow(b,k)}?`};
  }
  if(/округлен/.test(t)){
    const a=n(123,9876);const r=Math.round(a/100)*100;return{q:`Округли ${a} до сотен.`,answer:r,hint:'Смотри на цифру десятков: если она ≥ 5 — округляй вверх.'};
  }
  if(/пифагор/.test(t)){
    const p=[3,4,5,6,8,10,12][n(0,6)],q=[3,4,5,6,8,10,12][n(0,6)];const c=Math.hypot(p,q);
    if(Number.isInteger(c))return{q:`Катеты ${p} и ${q}. Найди гипотенузу.`,answer:c,hint:'c² = a² + b².'};
    return genTask(topic,difficulty);
  }
  // Концептуальный вопрос по понятиям темы (для любого предмета)
  const concepts = topic.concepts||[];
  const right = concepts[n(0,concepts.length-1)];
  const distr = Object.values(TOPIC_INDEX).flatMap(x=>x.concepts).filter(c=>c!==right);
  const opts = new Set([right]);
  while(opts.size<4&&distr.length) opts.add(distr[n(0,distr.length-1)]);
  const options=[...opts].sort(()=>Math.random()-.5);
  return{q:`Тема «${topic.name}». Какое понятие изучается в этой теме?`,options,answer:right,type:'choice',
    hint:`Ключевые понятия темы: ${concepts.join(', ')}.`};
}

// ---------------- Локальный AI-движок (fallback, без внешнего API) ----------------
function localAI(messages, context){
  const last = messages[messages.length-1]?.content||'';
  const topic = context?.topicName ? TOPIC_INDEX[Object.keys(TOPIC_INDEX).find(k=>TOPIC_INDEX[k].name===context.topicName)] : null;
  if(/логарифм/i.test(last)){
    return 'Логарифм — это показатель степени. log_b(a) отвечает на вопрос: «В какую степень нужно возвести b, чтобы получить a?». Ключевое свойство: log_b(xy) = log_b(x) + log_b(y). Хочешь потренируемся на задачах разной сложности?';
  }
  if(topic){
    return `По теме «${topic.name}» (${topic.subject}, ${topic.grade} класс) ключевые понятия: ${topic.concepts.slice(0,4).join(', ')}. Типичные ошибки учеников здесь: ${topic.mistakes.join('; ')}. Давай разберём пример — сгенерирую задание уровня ${context?.difficulty||1}.`;
  }
  return 'Я твой персональный AI-наставник: объясняю темы, разбираю ошибки и подбираю задания под твой уровень. Спроси о любой теме из каталога — или отправь фото задания, и я разберу его по шагам.';
}

async function callAI(messages, context){
  if(!AI_KEY) return {text: localAI(messages, context), engine:'local'};
  const sys = `Ты — персональный AI-репетитор в EdTech-платформе EduCore. Ты связан с учебным профилем ученика: слабые темы, история ошибок, текущие цели. Отвечай на русском, структурировано и ёмко, как наставник: объяснение → пример → мини-проверка. Контекст ученика: ${JSON.stringify(context||{})}. Список его тем и понятий доступен в контексте запроса.`;
  try{
    const r = await fetch(AI_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${AI_KEY}`},
      body:JSON.stringify({model:AI_MODEL,messages:[{role:'system',content:sys},...messages],temperature:0.5})});
    const j = await r.json();
    if(j.error) return {text: localAI(messages, context), engine:'local', warn:j.error.message};
    return {text: j.choices[0].message.content, engine: AI_MODEL};
  }catch(e){ return {text: localAI(messages, context), engine:'local', warn:String(e)}; }
}

// ---------------- API: каталог и темы ----------------
app.get('/api/catalog', (req,res)=>res.json({...CURRICULUM, topicsTotal:Object.keys(TOPIC_INDEX).length}));

app.get('/api/topic/:id', (req,res)=>{
  const t = TOPIC_INDEX[req.params.id];
  if(!t) return res.status(404).json({error:'Тема не найдена'});
  const st = loadStudent(); const ts = st.topics[t.id]||{mastery:0,difficulty:1,attempts:0};
  res.json({...t,
    summary:`${t.name} — тема раздела «${t.section}» (${t.subject}, ${t.grade} класс). Ключевые понятия: ${t.concepts.join(', ')}. Типичные трудности: ${t.mistakes.join('; ')}.`,
    example: genTask(t, 1),
    mastery: ts.mastery, difficulty: ts.difficulty, attempts: ts.attempts,
    review:`Повторение: кратко перескажи себе, что такое ${t.concepts[0]}, и решите 3 задачи уровня ${ts.difficulty||1}.`,
    criterion:`Тема считается освоенной при mastery ≥ ${Math.round(t.masteryCriterion*100)}% и серии из 3 верных ответов подряд на текущем уровне сложности.`});
});

// ---------------- API: AI-ядро ----------------
app.post('/api/ai/chat', async (req,res)=>{
  const {messages=[], context={}} = req.body;
  res.json(await callAI(messages.slice(-12), context));
});
app.post('/api/ai/explain', async (req,res)=>{
  const t = TOPIC_INDEX[req.body.topicId];
  if(!t) return res.status(404).json({error:'Тема не найдена'});
  res.json(await callAI([{role:'user',content:`Объясни тему «${t.name}» (${t.subject}, ${t.grade} класс). Ключевые понятия: ${t.concepts.join(', ')}. Типичные ошибки: ${t.mistakes.join('; ')}.`}], req.body.context));
});
app.post('/api/ai/task', async (req,res)=>{
  const t = TOPIC_INDEX[req.body.topicId];
  if(!t) return res.status(404).json({error:'Тема не найдена'});
  const st = loadStudent(); const ts = topicState(st, t.id);
  const difficulty = Math.min(3, req.body.difficulty || ts.difficulty || 1);
  let task = genTask(t, difficulty);
  if(AI_KEY){
    try{
      const r = await fetch(AI_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${AI_KEY}`},
        body:JSON.stringify({model:AI_MODEL,temperature:0.7,response_format:{type:'json_object'},
          messages:[{role:'system',content:'Ты генератор учебных заданий. Верни строго JSON: {"q":"текст задания","answer":"правильный ответ","hint":"подсказка"}. Для выбора из вариантов добавь "options":[...] и "type":"choice".'},
          {role:'user',content:`Тема: «${t.name}» (${t.subject}, ${t.grade} класс, понятия: ${t.concepts.join(', ')}). Сложность ${difficulty} из 3. Сгенерируй одно задание с проверяемым ответом.`}]})});
      const j = await r.json(); const raw = j.choices?.[0]?.message?.content;
      if(raw){ const parsed = JSON.parse(raw); if(parsed.q&&parsed.answer!==undefined) task = {...parsed, engine:AI_MODEL}; }
    }catch(e){/* fallback на локальный генератор */}
  }
  res.json({task, difficulty, topic:{id:t.id,name:t.name}, mastery:ts.mastery});
});
app.post('/api/ai/analyze-image', async (req,res)=>{
  const {image, question='Реши это задание и объясни по шагам, найди возможные ошибки ученика.'} = req.body;
  if(!image) return res.status(400).json({error:'Нет изображения'});
  if(!AI_KEY) return res.json({text:'Режим демо: подключи OPENAI_API_KEY в .env, чтобы я анализировал фото заданий (vision-модель). Сейчас опиши задание текстом — и я разберу его.', engine:'local'});
  try{
    const r = await fetch(AI_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${AI_KEY}`},
      body:JSON.stringify({model:process.env.OPENAI_VISION_MODEL||'gpt-4o',max_tokens:900,messages:[{role:'user',content:[
        {type:'text',text:`Ты AI-репетитор. ${question} Отвечай на русском.`},
        {type:'image_url',image_url:{url:image}}]}]})});
    const j = await r.json();
    res.json({text:j.choices[0].message.content, engine:'vision'});
  }catch(e){ res.json({text:'Не удалось проанализировать изображение: '+e.message, engine:'local'}); }
});

// ---------------- API: адаптивный движок ----------------
app.post('/api/attempt', (req,res)=>{
  const {topicId, correct, mistakeType=null, answerTimeSec=null} = req.body;
  const t = TOPIC_INDEX[topicId]; if(!t) return res.status(404).json({error:'Тема не найдена'});
  const st = loadStudent(); const ts = topicState(st, topicId);
  ts.attempts++;
  let nextAction;
  if(correct){
    ts.correct++; ts.streak++;
    ts.mastery = Math.min(1, ts.mastery + (1-ts.mastery)*0.22);
    if(ts.streak>=3 && ts.difficulty<3){
      ts.difficulty++; ts.streak=0; nextAction={type:'level_up', message:`Отлично! Повышаю сложность до уровня ${ts.difficulty}.`};
    } else if(ts.mastery>=t.masteryCriterion && ts.difficulty===3){
      nextAction={type:'topic_mastered', message:'Тема освоена! Переходим к следующей по плану.'};
    } else nextAction={type:'continue', message:'Верно! Держим темп.'};
  } else {
    ts.streak=0; ts.mastery=Math.max(0, ts.mastery - Math.max(0.04, ts.mastery*0.12));
    ts.lastMistake = mistakeType || t.mistakes[0];
    nextAction={type:'explain_and_retry', message:`Разберём ошибку: ${ts.lastMistake}. Вот похожее задание — попробуй ещё раз.`};
    if(ts.mastery<0.25 && ts.difficulty>1){ ts.difficulty--; nextAction.message+=' Снижаю сложность для закрепления базы.'; }
  }
  ts.updatedAt=new Date().toISOString();
  st.history.push({topicId, correct, mistakeType, answerTimeSec, at:ts.updatedAt});
  saveStudent(st);
  res.json({mastery:Math.round(ts.mastery*100), difficulty:ts.difficulty, streak:ts.streak, attempts:ts.attempts, nextAction, criterion:t.masteryCriterion,
    task: nextAction.type!=='topic_mastered' ? genTask(t, ts.difficulty) : null,
    explain: correct?null:`Причина ошибки: ${ts.lastMistake}. Подсказка по теме: опирайся на понятие «${t.concepts[0]}».`});
});
app.get('/api/profile', (req,res)=>{ const st=loadStudent();
  res.json({...st, weakTopics:Object.entries(st.topics).filter(([,v])=>v.mastery<0.5&&v.attempts>0).map(([k,v])=>({topic:TOPIC_INDEX[k]?.name||k, mastery:Math.round(v.mastery*100)}))});
});

app.listen(PORT, ()=>console.log(`EduCore → http://localhost:${PORT}  |  AI: ${AI_KEY?'внешний ('+AI_MODEL+')':'локальный движок'}`));
