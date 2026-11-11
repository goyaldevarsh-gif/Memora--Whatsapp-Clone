import React from 'react'
import ReactDOM from 'react-dom/client'
import { initUpdates } from './lib/update'
import App from './ui/App'
import './index.css'

initUpdates()
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
