"use client"

import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { getWorkspaces, createWorkspace, getWorkspaceFolders } from "@/lib/cascade-api"
import type { Workspace, WorkspaceFolder, WorkspaceResources, ResourceSnapshot } from "@/lib/cascade-api"
import { cn } from "@/lib/utils"
import { useTheme } from "@/lib/theme"
import { PluginManager } from "./plugin-manager"
import { API_BASE } from "@/lib/config"
import { authHeaders } from "@/lib/auth"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"

import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupAction,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarSeparator,
    useSidebar,
} from "@/components/ui/sidebar"

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Settings, User, Plug, Book, Globe, Moon, Sun, Plus, FolderOpen, FolderPlus, EllipsisVertical, Activity, FolderSync, Loader2, Circle, GitBranch, Monitor } from "lucide-react"

import { WorkspaceGroup } from "./sidebar/workspace-group"
import type { ConvSummary, WorkspaceData } from "./sidebar/workspace-group"
import { SystemResourceSummary } from "./sidebar/system-resource-summary"
import { markConversationRead, useConversationUnread } from '@/lib/conversation-read-state'

interface AppSidebarProps {
    currentConvId: string | null
    conversationsVersion: number
    /** Whether the Codex App Server is available through the Node bridge. */
    detected: boolean
    onSelectConversation: (convId: string | null, wsName: string) => void
    onSelectWorkspace: (wsName: string) => void
    onShowAccountInfo: () => void
    onShowSettings: () => void
    onShowLogs: () => void
    onShowAgentHub: () => void
    onShowOrchestrator: () => void
    onShowConnect: () => void
    onShowSourceControl: () => void
    onShowResources: () => void
    onGoHome: () => void
    activeWorkspace: string | null
    workspaceResources?: ResourceSnapshot | null
    wsVersion?: number
    onWorkspaceCreated?: () => void
    /** Called after a conversation is successfully deleted, with the deleted conv ID */
    onConvDeleted?: (convId: string, wsName: string) => void
}

export function AppSidebar({
    currentConvId,
    conversationsVersion,
    detected,
    onSelectConversation,
    onSelectWorkspace,
    onShowAccountInfo,
    onShowSettings,
    onShowLogs,
    onShowSourceControl,
    onShowResources,
    onGoHome,
    activeWorkspace,
    workspaceResources,
    wsVersion,
    onWorkspaceCreated,
    onConvDeleted,
}: AppSidebarProps) {
    const { isDark, toggle: toggleTheme } = useTheme()
    const { isMobile } = useSidebar()

    const [wsData, setWsData] = useState<WorkspaceData[]>([])
    const [folders, setFolders] = useState<WorkspaceFolder[]>([])
    const [loading, setLoading] = useState(true)
    const [openingFolder, setOpeningFolder] = useState<string | null>(null)
    const [newWsName, setNewWsName] = useState("")
    const [creating, setCreating] = useState(false)
    const [createError, setCreateError] = useState("")
    const [showPlugins, setShowPlugins] = useState(false)
    const [showCreateDialog, setShowCreateDialog] = useState(false)
    const [showAllMap, setShowAllMap] = useState<Record<string, boolean>>({})

    // User profile state
    const [userProfile, setUserProfile] = useState<{ name: string; tier: string; avatar: string | null } | null>(null)

    const hasLoadedRef = useRef(false)
    const allConversations = useMemo(() => wsData.flatMap((data) => data.conversations), [wsData])
    const unreadConversationIds = useConversationUnread(allConversations, currentConvId)

    const nameValidationError = useMemo(() => {
        const trimmed = newWsName.trim()
        if (!trimmed) return ""
        if (/[/\\:*?"<>|]/.test(trimmed)) return "Invalid characters in name"
        if (trimmed.length > 100) return "Name too long (max 100)"
        const lower = trimmed.toLowerCase()
        if (wsData.some((d) => d.workspace.workspaceName.toLowerCase() === lower))
            return "Workspace already active"
        if (folders.some((f) => f.name.toLowerCase() === lower))
            return "Folder already exists — open it from Available Workspaces"
        return ""
    }, [newWsName, wsData, folders])

    // Fetch user profile on mount and when connection is established
    const fetchUserProfile = useCallback(() => {
        if (!detected) {
            setUserProfile(null)
            return
        }
        fetch(`${API_BASE}/api/user/profile`, { headers: authHeaders() })
            .then(r => r.json())
            .then(d => {
                const u = d.user
                if (!u) return
                setUserProfile({
                    name: u.name || 'User',
                    tier: u.userTier?.name || u.planStatus?.planInfo?.planName || '',
                    avatar: d.profilePicture || null,
                })
            })
            .catch(() => { })
    }, [detected])

    useEffect(() => {
        fetchUserProfile()
    }, [fetchUserProfile])

    // Re-fetch profile when profile swap happens
    useEffect(() => {
        const handler = () => {
            // Retry a few times — IDE takes ~5-10s to restart
            const attempts = [5000, 8000, 12000];
            attempts.forEach(delay => setTimeout(() => fetchUserProfile(), delay));
        }
        window.addEventListener('profile-swapped', handler)
        return () => window.removeEventListener('profile-swapped', handler)
    }, [fetchUserProfile])

    const loadAll = useCallback(async () => {
        try {
            const wss = await getWorkspaces()

            // Fetch conversations for all workspaces in parallel
            const conversationsData = await Promise.all(
                wss.map(async (ws) => {
                    try {
                        const res = await fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(ws.workspaceName)}/conversations`, { headers: authHeaders() })
                        if (!res.ok) return [] as ConvSummary[]
                        const data = await res.json()
                        // API returns { trajectorySummaries: { [id]: info, ... } } — not an array
                        const summaries = data.trajectorySummaries || {}
                        return Object.entries(summaries).map(([id, info]: [string, any]) => ({
                            id,
                            summary: info.summary || 'Untitled',
                            stepCount: info.stepCount ?? 0,
                            lastModifiedTime: info.lastModifiedTime ?? '',
                            status: info.status ?? '',
                        })).sort((a, b) => (b.lastModifiedTime).localeCompare(a.lastModifiedTime)) as ConvSummary[]
                    } catch {
                        return [] as ConvSummary[]
                    }
                })
            )

            // Build a map keyed by workspace name
            const convMap = new Map<string, ConvSummary[]>()
            wss.forEach((ws, i) => convMap.set(ws.workspaceName, conversationsData[i] || []))

            setWsData((prev) => {
                // Build a map of previous expanded state keyed by workspace index
                const prevExpandedMap = new Map<string, boolean>(prev.map((d) => [d.workspace.workspaceName, d.expanded]))
                return wss.map((ws) => ({
                    workspace: ws,
                    conversations: convMap.get(ws.workspaceName) || [],
                    // Preserve user's manual expand/collapse; first workspace defaults to expanded
                    expanded: prevExpandedMap.has(ws.workspaceName) ? prevExpandedMap.get(ws.workspaceName)! : false,
                    loading: false,
                }))
            })

            try {
                const { folders: f } = await getWorkspaceFolders()
                setFolders(f)
            } catch { }
        } catch {
            setLoading(false)
        } finally {
            setLoading(false)
        }
    }, [])

    const refreshConversationStatuses = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/conversations`, { headers: authHeaders() })
            if (!res.ok) return
            const data = await res.json()
            const summaries = data.trajectorySummaries || {}
            setWsData((current) => current.map((workspaceData) => ({
                ...workspaceData,
                conversations: workspaceData.conversations.map((conversation) => {
                    const update = summaries[conversation.id]
                    if (!update) return conversation
                    return {
                        ...conversation,
                        status: typeof update.status === 'string' ? update.status : conversation.status,
                        lastModifiedTime: typeof update.lastModifiedTime === 'string'
                            ? update.lastModifiedTime
                            : conversation.lastModifiedTime,
                    }
                }),
            })))
        } catch { }
    }, [])

    useEffect(() => {
        if (!hasLoadedRef.current) {
            hasLoadedRef.current = true
            loadAll()
        }
    }, [loadAll])

    useEffect(() => {
        if (wsVersion && wsVersion > 0) loadAll()
    }, [wsVersion, loadAll])

    // Refresh workspace list when backend broadcasts conversations_updated or status change via WS
    useEffect(() => {
        if (conversationsVersion > 0) loadAll()
    }, [conversationsVersion, loadAll])

    useEffect(() => {
        if (!detected) return
        const refresh = () => {
            if (!document.hidden) void refreshConversationStatuses()
        }
        const interval = window.setInterval(refresh, 5000)
        document.addEventListener('visibilitychange', refresh)
        return () => {
            window.clearInterval(interval)
            document.removeEventListener('visibilitychange', refresh)
        }
    }, [detected, refreshConversationStatuses])

    // Validate restored activeWorkspace — clear if stale (e.g. old index "0" or deleted workspace)
    useEffect(() => {
        if (!loading && wsData.length > 0 && activeWorkspace !== null) {
            const found = wsData.some(d => d.workspace.workspaceName === activeWorkspace)
            if (!found) {
                onSelectWorkspace(wsData[0].workspace.workspaceName)
            }
        }
    }, [loading, wsData, activeWorkspace, onSelectWorkspace])


    // TODO: Temporarily disabled 30s polling — workspace updates now driven by WS events
    // (conversationsVersion from useWebSocket). Re-enable if WS proves unreliable.
    // useEffect(() => {
    //     let interval: ReturnType<typeof setInterval> | null = null
    //     const start = () => {
    //         if (!interval) interval = setInterval(loadAll, 30000)
    //     }
    //     const stop = () => {
    //         if (interval) {
    //             clearInterval(interval)
    //             interval = null
    //         }
    //     }
    //     const onVisibility = () => (document.hidden ? stop() : start())
    //
    //     start()
    //     document.addEventListener("visibilitychange", onVisibility)
    //     return () => {
    //         stop()
    //         document.removeEventListener("visibilitychange", onVisibility)
    //     }
    // }, [loadAll])

    const handleWorkspaceClick = useCallback(
        (arrayIdx: number) => {
            const wd = wsData[arrayIdx]
            if (!wd) return
            // Always expand when selecting; only collapse if already expanded (toggle)
            setWsData((prev) => prev.map((d, i) => {
                if (i !== arrayIdx) return d
                // If clicking the already-expanded workspace, collapse it; otherwise always expand
                return { ...d, expanded: !d.expanded }
            }))
            onSelectWorkspace(wd.workspace.workspaceName)
        },
        [wsData, onSelectWorkspace]
    )

    const handleSelectConv = useCallback(
        async (convId: string, arrayIdx: number) => {
            const wd = wsData[arrayIdx]
            if (!wd) return
            const conversation = wd.conversations.find((item) => item.id === convId)
            if (conversation) markConversationRead(conversation.id, conversation.lastModifiedTime)
            onSelectConversation(convId, wd.workspace.workspaceName)
        },
        [wsData, onSelectConversation]
    )

    // Called by WorkspaceGroup after a conversation is successfully deleted.
    // Optimistically removes the conv from local state so the UI updates instantly,
    // then re-fetches from the server to stay in sync.
    const handleConvDeleted = useCallback(
        (convId: string, wsName: string) => {
            setWsData((prev) =>
                prev.map((wd) => {
                    // Only touch the workspace that owned this conversation —
                    // all others return the same reference (no re-render).
                    if (wd.workspace.workspaceName !== wsName) return wd
                    return {
                        ...wd,
                        conversations: wd.conversations.filter((c) => c.id !== convId),
                    }
                })
            )
            // Notify page.tsx so it can navigate away if viewing the deleted conv
            onConvDeleted?.(convId, wsName)
            // Re-fetch in the background to ensure full consistency
            loadAll()
        },
        [loadAll, onConvDeleted]
    )

    const handleWorkspaceRemoved = useCallback((workspaceName: string) => {
        setWsData((current) => current.filter((item) => item.workspace.workspaceName !== workspaceName))
        setFolders((current) => current.map((folder) =>
            folder.name === workspaceName ? { ...folder, open: false, wsName: null } : folder
        ))
        if (activeWorkspace === workspaceName) onGoHome()
        void loadAll()
    }, [activeWorkspace, loadAll, onGoHome])

    const handleCreateByName = useCallback(async () => {
        const name = newWsName.trim()
        if (!name || creating || nameValidationError) return
        setCreating(true)
        setCreateError("")
        try {
            await createWorkspace(name, true)
            setNewWsName("")
            await loadAll()
            onWorkspaceCreated?.()
            setShowCreateDialog(false)
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Failed to create workspace"
            setCreateError(msg)
        } finally {
            setCreating(false)
        }
    }, [newWsName, creating, nameValidationError, loadAll, onWorkspaceCreated])

    const handleOpenFolder = useCallback(
        async (folder: WorkspaceFolder) => {
            if (folder.open || openingFolder === folder.name) return
            setOpeningFolder(folder.name)
            try {
                await createWorkspace(folder.path)
                await loadAll()
                onWorkspaceCreated?.()
            } catch (e) {
                console.error("Open failed:", e)
            } finally {
                setOpeningFolder(null)
            }
        },
        [openingFolder, loadAll, onWorkspaceCreated]
    )

    const regularWs = wsData.filter((d) => d.workspace.category !== "playground")
    const playgroundWs = wsData.filter((d) => d.workspace.category === "playground")

    const activeWsNames = new Set(wsData.map((d) => d.workspace.workspaceName.toLowerCase()))
    const closedFolders = folders.filter((f) => !f.open && !activeWsNames.has(f.name.toLowerCase()))

    return (
        <>
            <Sidebar variant="inset">
                <SidebarHeader>
                    <button
                        onClick={onGoHome}
                        className="flex items-center gap-2 px-4 py-2 mt-2 hover:opacity-80 transition-opacity cursor-pointer"
                    >
                        <FolderSync className="h-5 w-5 text-primary" />
                        <span className="font-semibold text-lg tracking-tight">Sim Desk</span>
                    </button>
                </SidebarHeader>

                {/* System Resource Summary — compact CPU/RAM bars */}
                <div className="px-3 pb-1">
                    <SystemResourceSummary
                        system={workspaceResources?.system}
                        onClick={onShowResources}
                    />
                </div>

                <SidebarContent>
                    <SidebarSeparator className="mx-0" />
                    <SidebarGroup>
                        <SidebarGroupLabel>Active Workspaces</SidebarGroupLabel>
                        <SidebarGroupContent>
                            {loading && <div className="px-3 py-4 text-xs text-muted-foreground text-center">Loading...</div>}
                            {regularWs.map((wd) => {
                                const arrayIdx = wsData.indexOf(wd)
                                return (
                                    <WorkspaceGroup
                                        key={wd.workspace.workspaceName}
                                        data={wd}
                                        showAll={!!showAllMap[arrayIdx]}
                                        currentConvId={currentConvId}
                                        resources={workspaceResources?.workspaces?.[wd.workspace.pid]}
                                        unreadConversationIds={unreadConversationIds}
                                        onToggleExpand={() => handleWorkspaceClick(arrayIdx)}
                                        onSelectConv={(convId) => handleSelectConv(convId, arrayIdx)}
                                        onToggleShowAll={() => setShowAllMap((prev) => ({ ...prev, [arrayIdx]: true }))}
                                        onDeleted={handleConvDeleted}
                                        onWorkspaceRemoved={handleWorkspaceRemoved}
                                    />
                                )
                            })}
                        </SidebarGroupContent>
                    </SidebarGroup>

                    {closedFolders.length > 0 && (
                        <>
                            <SidebarSeparator className="mx-0" />
                            <SidebarGroup>
                                <SidebarGroupLabel>Available Workspaces</SidebarGroupLabel>
                                <SidebarGroupContent>
                                    <SidebarMenu>
                                        {closedFolders.map((folder) => (
                                            <SidebarMenuItem key={folder.name}>
                                                <SidebarMenuButton
                                                    onClick={() => void handleOpenFolder(folder)}
                                                    disabled={openingFolder === folder.name}
                                                    tooltip={folder.name}
                                                    className="text-xs !pr-2"
                                                >
                                                    <FolderOpen className="shrink-0" />
                                                    <span className="flex-1 truncate min-w-0">{folder.name}</span>
                                                    <span className="ml-auto opacity-0 group-hover/menu-item:opacity-100 text-[9px] text-muted-foreground/50 transition-opacity shrink-0">
                                                        {openingFolder === folder.name ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Open'}
                                                    </span>
                                                </SidebarMenuButton>
                                            </SidebarMenuItem>
                                        ))}
                                    </SidebarMenu>
                                </SidebarGroupContent>
                            </SidebarGroup>
                        </>
                    )}

                    <SidebarSeparator className="mx-0" />

                    <div className="px-4 py-3">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setShowCreateDialog(true)}
                            className="w-full h-8 text-xs gap-1.5"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            New Workspace
                        </Button>
                    </div>

                    {playgroundWs.length > 0 && (
                        <>
                            <SidebarSeparator className="mx-0" />
                            <SidebarGroup>
                                <SidebarGroupLabel className="flex items-center justify-between">
                                    <span>Playground</span>
                                    <Circle className="h-3 w-3 text-muted-foreground/30" />
                                </SidebarGroupLabel>
                                <SidebarGroupContent>
                                    {playgroundWs.map((wd) => {
                                        const arrayIdx = wsData.indexOf(wd)
                                        return (
                                            <WorkspaceGroup
                                                key={wd.workspace.workspaceName}
                                                data={wd}
                                                showAll={!!showAllMap[arrayIdx]}
                                                currentConvId={currentConvId}
                                                resources={workspaceResources?.workspaces?.[wd.workspace.pid]}
                                                unreadConversationIds={unreadConversationIds}
                                                onToggleExpand={() => handleWorkspaceClick(arrayIdx)}
                                                onSelectConv={(convId) => handleSelectConv(convId, arrayIdx)}
                                                onToggleShowAll={() => setShowAllMap((prev) => ({ ...prev, [arrayIdx]: true }))}
                                                onDeleted={handleConvDeleted}
                                                onWorkspaceRemoved={handleWorkspaceRemoved}
                                            />
                                        )
                                    })}
                                </SidebarGroupContent>
                            </SidebarGroup>
                        </>
                    )}
                    <SidebarSeparator className="mx-0" />
                    <SidebarGroup>
                        <SidebarGroupContent>
                            <SidebarMenu>
                                <SidebarMenuItem>
                                    <SidebarMenuButton onClick={onShowSourceControl} tooltip="Files & Git" className="text-xs">
                                        <GitBranch className="shrink-0" />
                                        <span>Files & Git</span>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                                {/* Orchestrator hidden while chat-first redesign is in progress
                                <SidebarMenuItem>
                                    <SidebarMenuButton onClick={onShowOrchestrator} tooltip="Orchestrator" className="text-xs">
                                        <Workflow className="shrink-0" />
                                        <span>Orchestrator</span>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                                */}
                                <SidebarMenuItem>
                                    <SidebarMenuButton onClick={onShowResources} tooltip="Resources" className="text-xs">
                                        <Monitor className="shrink-0" />
                                        <span>Resources</span>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                </SidebarContent>

                <SidebarFooter>
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <SidebarMenuButton
                                        size="lg"
                                        className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                                    >
                                        <Avatar className="h-8 w-8 rounded-lg">
                                            {userProfile?.avatar && (
                                                <AvatarImage src={`data:image/png;base64,${userProfile.avatar}`} alt={userProfile.name} />
                                            )}
                                            <AvatarFallback className={cn(
                                                "rounded-lg text-xs font-semibold",
                                                detected ? "bg-indigo-500/20 text-indigo-400" : "bg-muted text-muted-foreground"
                                            )}>
                                                {userProfile?.name?.[0]?.toUpperCase() ?? (detected ? '?' : '—')}
                                            </AvatarFallback>
                                        </Avatar>
                                        <div className="grid flex-1 text-left text-sm leading-tight">
                                            <span className="truncate font-medium text-xs">
                                                {userProfile?.name ?? (detected ? 'Loading...' : 'Not Connected')}
                                            </span>
                                            <span className="truncate text-[10px] text-sidebar-foreground/60">
                                                {userProfile?.tier ?? (detected ? '' : 'Codex unavailable')}
                                            </span>
                                        </div>
                                        <EllipsisVertical className="ml-auto size-4" />
                                    </SidebarMenuButton>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    side={isMobile ? "bottom" : "right"}
                                    align="end"
                                    sideOffset={4}
                                    className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
                                >
                                    <DropdownMenuItem onClick={onShowAccountInfo}>
                                        <User className="mr-2 h-4 w-4" />
                                        <span>Account & Plan</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={onShowLogs}>
                                        <Activity className="mr-2 h-4 w-4" />
                                        <span>Live Logs</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={onShowSourceControl}>
                                        <GitBranch className="mr-2 h-4 w-4" />
                                        <span>Source Control</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={onShowResources}>
                                        <Monitor className="mr-2 h-4 w-4" />
                                        <span>Resources</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={toggleTheme}>
                                        {isDark ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}
                                        <span>{isDark ? "Light Mode" : "Dark Mode"}</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => setShowPlugins(true)}>
                                        <Plug className="mr-2 h-4 w-4" />
                                        <span>Plugins</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem disabled>
                                        <Book className="mr-2 h-4 w-4 text-muted-foreground" />
                                        <span className="text-muted-foreground">Knowledge (Coming Soon)</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem disabled>
                                        <Globe className="mr-2 h-4 w-4 text-muted-foreground" />
                                        <span className="text-muted-foreground">Browser (Coming Soon)</span>
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={onShowSettings}>
                                        <Settings className="mr-2 h-4 w-4" />
                                        <span>App Settings</span>
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </SidebarFooter>

                <PluginManager open={showPlugins} onClose={() => setShowPlugins(false)} />
            </Sidebar>

            <Dialog open={showCreateDialog} onOpenChange={(open) => {
                setShowCreateDialog(open)
                if (!open) { setNewWsName(""); setCreateError("") }
            }}>
                <DialogContent className="sm:max-w-[420px]">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <FolderPlus className="h-5 w-5" />
                            New Workspace
                        </DialogTitle>
                        <DialogDescription>
                            Create a workspace for Codex CLI tasks.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4 py-2">
                        <div className="space-y-2.5">
                            <label className="text-xs font-medium text-muted-foreground">Workspace Name</label>
                            <Input
                                value={newWsName}
                                onChange={(e) => { setNewWsName(e.target.value); setCreateError("") }}
                                onKeyDown={(e) => e.key === "Enter" && !nameValidationError && handleCreateByName()}
                                placeholder="my-awesome-project"
                                className={cn(nameValidationError && newWsName.trim() && "border-destructive focus-visible:ring-destructive")}
                                disabled={creating}
                                autoFocus
                            />
                            {(nameValidationError || createError) && newWsName.trim() && (
                                <p className="text-xs text-destructive">{nameValidationError || createError}</p>
                            )}
                            <p className="text-xs text-muted-foreground">
                                This will create a folder in your workspace root directory.
                            </p>
                        </div>

                    </div>

                    <DialogFooter>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { setShowCreateDialog(false); setNewWsName(""); setCreateError("") }}
                            disabled={creating}
                        >
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            onClick={async () => { await handleCreateByName() }}
                            disabled={creating || !newWsName.trim() || !!nameValidationError}
                        >
                            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
                            Create Workspace
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

        </>
    )
}
