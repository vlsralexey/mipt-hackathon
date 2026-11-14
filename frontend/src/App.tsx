import { Route, Routes } from 'react-router'
import { AppShell } from './app/AppShell'
import { EmptyWorkspace } from './pages/EmptyWorkspace'
import { NewProcurementPage } from './pages/NewProcurementPage'
import { ProcurementPage } from './pages/ProcurementPage'
import { SettingsPage } from './pages/SettingsPage'

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<EmptyWorkspace />} />
        <Route path="new" element={<NewProcurementPage />} />
        <Route path="p/:id" element={<ProcurementPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<EmptyWorkspace />} />
      </Route>
    </Routes>
  )
}
