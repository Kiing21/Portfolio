\# Full-Stack To-Do App



A full-stack to-do list application with:



\- User registration \& login (JWT auth)

\- Tasks with category, priority, due date \& time

\- Descriptions with autosave

\- Subtasks for each main task

\- Search, filter and sort (by status, due date, created date, priority)

\- Dark / light mode toggle

\- Undo snackbar for delete / toggle

\- JSON backup \& restore for tasks



Frontend is built with \*\*React (Vite)\*\*, backend with \*\*Node.js + Express + SQLite\*\*.

Backend is deployed on \*\*Railway\*\*, frontend on \*\*Vercel\*\*.



---



\## Tech Stack



\*\*Frontend\*\*



\- React (Vite)

\- Axios

\- CSS (custom styles)



\*\*Backend\*\*



\- Node.js + Express

\- SQLite3 (file-based DB)

\- JSON Web Tokens (JWT) for auth

\- CORS



---



\## Project Structure



```text

todo-fullstack/

├─ client/          # Vite React frontend

│  ├─ src/

│  └─ .env.sample

├─ server/          # Express backend + SQLite

│  ├─ server.js

│  ├─ data/         # SQLite database todos.db (created at runtime)

│  └─ .env.sample

└─ README.md



