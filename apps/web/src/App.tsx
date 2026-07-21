import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AdminShell from './admin/AdminShell'
import ChannelsPage from './admin/Channels'
import AdminLogin from './admin/Login'
import LogsPage from './admin/Logs'
import ModelsPage from './admin/Models'
import SettingsPage from './admin/Settings'
import UsersPage from './admin/Users'
import UserDetailPage from './admin/UserDetail'
import Dashboard from './dashboard/Dashboard'
import Home from './landing/Home'

export default function App() {
	return (
		<BrowserRouter>
			<Routes>
				<Route path="/" element={<Home />} />
				<Route path="/dashboard" element={<Dashboard />} />
				<Route path="/admin/login" element={<AdminLogin />} />
				<Route path="/admin" element={<AdminShell />}>
					<Route index element={<Navigate to="channels" replace />} />
					<Route path="channels" element={<ChannelsPage />} />
					<Route path="models" element={<ModelsPage />} />
					<Route path="users" element={<UsersPage />} />
					<Route path="users/:id" element={<UserDetailPage />} />
					<Route path="logs" element={<LogsPage />} />
					<Route path="settings" element={<SettingsPage />} />
				</Route>
				<Route path="*" element={<Navigate to="/" replace />} />
			</Routes>
		</BrowserRouter>
	)
}
