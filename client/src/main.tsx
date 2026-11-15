import React from 'react'
import ReactDOM from 'react-dom/client'
import { configureModalAppElement } from '@rin/ui'
import 'remixicon/fonts/remixicon.css'
import App from './App'
import './index.css'
import './components.css'
import { GlobalErrorBoundary } from './components/error-boundary.tsx'
import { bootstrapApp } from './app/bootstrap'
import { clearLegacyAuthToken } from './utils/auth'

// 旧版本把 JWT 存在 localStorage，这里顺手清理掉
clearLegacyAuthToken()
bootstrapApp()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GlobalErrorBoundary>
      <App />
    </GlobalErrorBoundary>
  </React.StrictMode>
)
configureModalAppElement('#root');
