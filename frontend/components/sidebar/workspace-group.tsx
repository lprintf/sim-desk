"use client"

import { useState } from 'react'
import { Trash2, ChevronRight, FolderIcon, FolderMinus, Loader2, MessageSquare, Terminal } from 'lucide-react'
import { API_BASE } from '@/lib/config'
import { authHeaders } from '@/lib/auth'
import { removeWorkspace } from '@/lib/cascade-api'
import { ResourceBar } from './resource-bar'
import { ConversationStatusIndicator } from '@/components/conversation-status-indicator'
import type { WorkspaceResources } from '@/lib/cascade-api'
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
    SidebarMenu,
    SidebarMenuAction,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuSkeleton,
    SidebarMenuSub,
    SidebarMenuSubButton,
    SidebarMenuSubItem,
} from '@/components/ui/sidebar'
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { Workspace } from '@/lib/cascade-api'

const SHOW_LIMIT = 4

export interface ConvSummary {
    id: string
    summary: string
    stepCount: number
    lastModifiedTime: string
    status?: string
}

export interface WorkspaceData {
    workspace: Workspace
    conversations: ConvSummary[]
    loading: boolean
    expanded: boolean
}

export function WorkspaceGroup({
    data,
    showAll,
    currentConvId,
    resources,
    onToggleExpand,
    onSelectConv,
    onToggleShowAll,
    onDeleted,
    onWorkspaceRemoved,
    unreadConversationIds,
}: {
    data: WorkspaceData
    showAll: boolean
    currentConvId: string | null
    resources?: WorkspaceResources
    onToggleExpand: () => void
    onSelectConv: (convId: string) => void
    onToggleShowAll: () => void
    onDeleted?: (convId: string, wsName: string) => void
    onWorkspaceRemoved?: (wsName: string) => void
    unreadConversationIds: ReadonlySet<string>
}) {
    const [deleteTarget, setDeleteTarget] = useState<ConvSummary | null>(null)
    const [removeOpen, setRemoveOpen] = useState(false)
    const [removing, setRemoving] = useState(false)
    const [removeError, setRemoveError] = useState('')

    const visibleConvs = showAll ? data.conversations : data.conversations.slice(0, SHOW_LIMIT)
    const hasMore = !showAll && data.conversations.length > SHOW_LIMIT

    const handleConfirmDelete = async () => {
        if (!deleteTarget) return
        const targetId = deleteTarget.id
        // Optimistically close the dialog immediately for snappy UX
        setDeleteTarget(null)
        try {
            const res = await fetch(`${API_BASE}/api/cascade/${targetId}`, {
                method: 'DELETE',
                headers: authHeaders(),
            })
            if (!res.ok) throw new Error(`Delete failed: ${res.status}`)
            // Notify parent after successful deletion
            onDeleted?.(targetId, data.workspace.workspaceName)
        } catch (err) {
            console.error('Failed to delete conversation:', err)
        }
    }

    const handleConfirmRemove = async () => {
        if (removing) return
        setRemoving(true)
        setRemoveError('')
        try {
            await removeWorkspace(data.workspace.workspaceName)
            setRemoveOpen(false)
            onWorkspaceRemoved?.(data.workspace.workspaceName)
        } catch (error) {
            setRemoveError(error instanceof Error ? error.message : 'Failed to remove workspace')
        } finally {
            setRemoving(false)
        }
    }

    return (
        <>
            <SidebarMenu>
                <SidebarMenuItem className="group/workspace">
                    <Collapsible
                        open={data.expanded}
                        onOpenChange={onToggleExpand}
                        className="group/collapsible"
                    >
                        <CollapsibleTrigger asChild>
                            <SidebarMenuButton tooltip={data.workspace.workspaceName} className="text-xs !pr-12">
                                {data.workspace.headless
                                    ? <Terminal className="shrink-0 text-emerald-500" />
                                    : <FolderIcon className="shrink-0" />}
                                <span className="flex-1 truncate min-w-0">{data.workspace.workspaceName}</span>
                                {data.workspace.headless && (
                                    <span className="shrink-0 text-[8px] font-medium text-emerald-500/70 bg-emerald-500/10 px-1 py-0.5 rounded">HL</span>
                                )}
                                {resources && <ResourceBar cpuPercent={resources.cpuPercent} memMB={resources.memMB} />}
                                <span className="ml-auto mr-5 flex h-4 w-4 shrink-0 items-center justify-center">
                                    <ChevronRight className="h-4 w-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                                </span>
                            </SidebarMenuButton>
                        </CollapsibleTrigger>

                        <CollapsibleContent>
                            <SidebarMenuSub>
                                {data.loading ? (
                                    <>
                                        <SidebarMenuSubItem>
                                            <SidebarMenuSkeleton showIcon />
                                        </SidebarMenuSubItem>
                                        <SidebarMenuSubItem>
                                            <SidebarMenuSkeleton showIcon />
                                        </SidebarMenuSubItem>
                                    </>
                                ) : data.conversations.length === 0 ? (
                                    <SidebarMenuSubItem>
                                        <span className="px-2 py-1 text-[10px] text-sidebar-foreground/40 italic">
                                            No conversations
                                        </span>
                                    </SidebarMenuSubItem>
                                ) : (
                                    <>
                                        {visibleConvs.map(conv => (
                                            <SidebarMenuSubItem key={conv.id} className="group/conv">
                                                <SidebarMenuSubButton
                                                    isActive={conv.id === currentConvId}
                                                    onClick={() => onSelectConv(conv.id)}
                                                    title={`${conv.summary}\n${conv.stepCount} steps · ${conv.id}`}
                                                    className="text-xs peer pr-8"
                                                >
                                                    <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                                                        <MessageSquare className="h-3 w-3" />
                                                        <ConversationStatusIndicator
                                                            status={conv.status}
                                                            unread={unreadConversationIds.has(conv.id)}
                                                            className="absolute -right-1 -top-0.5"
                                                        />
                                                    </span>
                                                    <span className="truncate min-w-0">{conv.summary}</span>
                                                </SidebarMenuSubButton>
                                                <SidebarMenuAction
                                                    className="!top-1/2 !-translate-y-1/2 opacity-100 sm:opacity-0 sm:group-hover/conv:opacity-100 text-sidebar-foreground/30 hover:text-destructive hover:bg-destructive/10"
                                                    title="Delete conversation"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        setDeleteTarget(conv)
                                                    }}
                                                >
                                                    <Trash2 />
                                                </SidebarMenuAction>
                                            </SidebarMenuSubItem>
                                        ))}
                                        {hasMore && (
                                            <SidebarMenuSubItem>
                                                <SidebarMenuSubButton
                                                    onClick={onToggleShowAll}
                                                    className="text-sidebar-foreground/50 text-[10px]"
                                                >
                                                    {data.conversations.length - SHOW_LIMIT} more…
                                                </SidebarMenuSubButton>
                                            </SidebarMenuSubItem>
                                        )}
                                    </>
                                )}
                            </SidebarMenuSub>
                        </CollapsibleContent>
                    </Collapsible>
                    <SidebarMenuAction
                        className="!top-1/2 !-translate-y-1/2 opacity-100 text-sidebar-foreground/35 hover:bg-amber-500/10 hover:text-amber-400 sm:opacity-0 sm:group-hover/workspace:opacity-100"
                        title="Remove workspace from Deck"
                        onClick={(event) => {
                            event.stopPropagation()
                            setRemoveError('')
                            setRemoveOpen(true)
                        }}
                    >
                        <FolderMinus />
                    </SidebarMenuAction>
                </SidebarMenuItem>
            </SidebarMenu>

            {/* Delete confirmation dialog */}
            <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete conversation</AlertDialogTitle>
                        <AlertDialogDescription>
                            Delete &ldquo;{deleteTarget?.summary}&rdquo;? This action cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={handleConfirmDelete}
                        >
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={removeOpen} onOpenChange={(open) => { if (!removing) setRemoveOpen(open) }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Remove workspace from Deck?</AlertDialogTitle>
                        <AlertDialogDescription>
                            <span className="font-medium text-foreground">{data.workspace.workspaceName}</span> will move to Available Workspaces.
                            Its directory, Git data, and Codex threads will remain on disk.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    {removeError && <p className="text-xs text-destructive">{removeError}</p>}
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            disabled={removing}
                            onClick={(event) => {
                                event.preventDefault()
                                void handleConfirmRemove()
                            }}
                        >
                            {removing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                            Remove workspace
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    )
}
