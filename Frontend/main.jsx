import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './nl-sql-agent-postgres.jsx'

// Simple default styling reset if CSS isn't fully configured yet
const style = document.createElement('style');
style.textContent = `
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f3f4f6; }
`;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)