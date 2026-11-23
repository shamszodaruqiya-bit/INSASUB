# INFASUB

Сайт (index.html) + сервер входа по Gmail (server.js).

## Файлы
- `index.html` — весь сайт
- `server.js`, `package.json` — сервер на Render (отправляет код на Gmail через Brevo, хранит пользователей)

## Переменные на Render (сервис infasub-api → Environment)
| Имя | Значение |
|---|---|
| `BREVO_API_KEY` | ключ Brevo (xkeysib-...) |
| `SENDER_EMAIL` | Gmail, подтверждённый в Brevo (Senders) |
| `SITE_URL` | адрес сайта, например `https://infasub.onrender.com/` |
| `UPSTASH_REDIS_REST_URL` | из Upstash (чтобы пользователи не пропадали) |
| `UPSTASH_REDIS_REST_TOKEN` | из Upstash |
| `ADMIN_EMAIL` | (необязательно) по умолчанию shamszodaruqiya@gmail.com |

## Администратор
Администратор — `shamszodaruqiya@gmail.com`. Зарегистрируйтесь с этой почтой, и в разделе
«Пользователи» вы увидите почты всех и кнопку «Удалить».
