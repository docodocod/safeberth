import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
// 렌더 전에 fetch 를 감싸야 하므로 App 보다 먼저 (VITE_SNAPSHOT=1 일 때만 동작)
import './snapshotMode';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
