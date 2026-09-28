[README.md](https://github.com/user-attachments/files/32714989/README.md)

# EduCore — запуск

1. cd educore-app
2. npm install
3. cp .env.example .env   →  вставь OPENAI_API_KEY (без ключа работает локальный демо-режим)
4. npm start              →  http://localhost:3000

## Структура
  server.js            — backend: AI-ядро (прокси к LLM + vision), адаптивный движок, API
  data/curriculum.js   — учебная база: 1–12 класс → предмет → раздел → тема (+ понятия, ошибки)
  students/default.json— профиль ученика (mastery, серии, история попыток)
  public/index.html    — фронтенд (существующий UI + Каталог программ + Тема + адаптивный тренажёр)

## API
  GET  /api/catalog          — вся программа (мета: страна, локаль, версия схемы)
  GET  /api/topic/:id        — тема: объяснение, пример, критерий освоения, mastery ученика
  POST /api/ai/chat          — диалог с AI-наставником (контекст профиля ученика)
  POST /api/ai/explain       — объяснение темы
  POST /api/ai/task          — генерация задания (LLM, fallback — локальный генератор)
  POST /api/ai/analyze-image — анализ фото задания (vision)
  POST /api/attempt          — адаптивный движок: верно → сложность↑, неверно → объяснение + retry
  GET  /api/profile          — профиль + слабые темы

## Масштабирование
Новая страна/язык = новый data/curriculum.<locale>.js по той же схеме.
БД: заменить students/*.json на PostgreSQL/Mongo — API не меняется.
