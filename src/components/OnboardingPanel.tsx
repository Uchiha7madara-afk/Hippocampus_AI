import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Circle,
  Clock,
  Lock,
  Plus,
  Terminal,
  Users,
} from 'lucide-react';
import {
  EngineerCohortSummary,
  IndexedDocument,
  OnboardingPayload,
  OnboardingPhase,
  RbacRole,
} from '../types/app.ts';

interface OnboardingPanelProps {
  onboarding: OnboardingPayload | null;
  documents: IndexedDocument[];
  activeRole: RbacRole;
  loading: boolean;
  onToggleMilestone: (params: {
    targetUid?: string;
    userHandle: string;
    trackId: number;
    completed: boolean;
  }) => Promise<void>;
  onCreateTrack: (payload: {
    phase: OnboardingPhase;
    title: string;
    description: string;
    category: string;
    targetRole: RbacRole;
    linkedDocTitle?: string;
    verificationPrompt?: string;
    estimatedMinutes: number;
  }) => Promise<void>;
  onAskMentorInPlayground: (prompt: string) => void;
}

const PHASES: ('all' | OnboardingPhase)[] = [
  'all',
  'Day 1',
  'Week 1',
  'Month 1',
];

export function OnboardingPanel({
  onboarding,
  documents,
  activeRole,
  loading,
  onToggleMilestone,
  onCreateTrack,
  onAskMentorInPlayground,
}: OnboardingPanelProps) {
  const [phaseFilter, setPhaseFilter] = useState<'all' | OnboardingPhase>(
    'all'
  );
  const [selectedHandle, setSelectedHandle] = useState<string>('@alex.chen');
  const [togglingTrackId, setTogglingTrackId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Add Custom Milestone Form State (Manager / Admin)
  const [showAddForm, setShowAddForm] = useState(false);
  const [newPhase, setNewPhase] = useState<OnboardingPhase>('Day 1');
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newCategory, setNewCategory] = useState('Environment');
  const [newTargetRole, setNewTargetRole] = useState<RbacRole>('Engineer');
  const [newLinkedDoc, setNewLinkedDoc] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [newMinutes, setNewMinutes] = useState(25);
  const [creatingTrack, setCreatingTrack] = useState(false);

  const isManagerOrAdmin = activeRole === 'Admin' || activeRole === 'Manager';
  const tracks = onboarding?.tracks || [];
  const cohort = onboarding?.cohort || [];

  useEffect(() => {
    if (onboarding?.activeUserHandle && !isManagerOrAdmin) {
      setSelectedHandle(onboarding.activeUserHandle);
    } else if (
      cohort.length > 0 &&
      !cohort.some((c) => c.userHandle === selectedHandle)
    ) {
      setSelectedHandle(cohort[0].userHandle);
    }
  }, [onboarding?.activeUserHandle, isManagerOrAdmin, cohort, selectedHandle]);

  const activeEngineer: EngineerCohortSummary | undefined =
    cohort.find((c) => c.userHandle === selectedHandle) || cohort[0];

  const filteredTracks = tracks.filter(
    (t) => phaseFilter === 'all' || t.phase === phaseFilter
  );

  const remainingMinutes = tracks.reduce((sum, t) => {
    const done = activeEngineer?.progressByTrackId[t.id]?.completed;
    return done ? sum : sum + t.estimatedMinutes;
  }, 0);

  const cohortAvgCompletion =
    cohort.length > 0
      ? Math.round(
          cohort.reduce((acc, c) => acc + c.completionRate, 0) / cohort.length
        )
      : 0;

  const handleToggle = async (trackId: number, currentCompleted: boolean) => {
    const targetUserHandle =
      activeEngineer?.userHandle || onboarding?.activeUserHandle;
    const targetUid = activeEngineer?.userUid || onboarding?.activeUserUid;
    if (!targetUserHandle) return;
    setTogglingTrackId(trackId);
    setFeedback(null);
    try {
      await onToggleMilestone({
        targetUid,
        userHandle: targetUserHandle,
        trackId,
        completed: !currentCompleted,
      });
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Unable to update milestone completion.',
      });
    } finally {
      setTogglingTrackId(null);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newDesc.trim()) return;
    setCreatingTrack(true);
    setFeedback(null);
    try {
      await onCreateTrack({
        phase: newPhase,
        title: newTitle.trim(),
        description: newDesc.trim(),
        category: newCategory.trim() || 'Environment',
        targetRole: newTargetRole,
        linkedDocTitle: newLinkedDoc || undefined,
        verificationPrompt: newPrompt.trim() || undefined,
        estimatedMinutes: Number(newMinutes) || 25,
      });
      setNewTitle('');
      setNewDesc('');
      setNewPrompt('');
      setShowAddForm(false);
      setFeedback({
        type: 'success',
        text: `Added "${newTitle.trim()}" to the ${newPhase} onboarding curriculum.`,
      });
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to create onboarding milestone.',
      });
    } finally {
      setCreatingTrack(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Top 4-Column KPI Summary Row */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>
              {activeEngineer
                ? `${activeEngineer.displayName} Progress`
                : 'Engineer Progress'}
            </span>
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          </div>
          <p className="font-mono text-2xl font-bold text-white tabular-nums">
            {activeEngineer?.completionRate ?? 0}%
          </p>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${activeEngineer?.completionRate ?? 0}%` }}
            />
          </div>
          <p className="text-xs text-slate-400 font-mono tabular-nums">
            {activeEngineer?.completedCount ?? 0} of{' '}
            {activeEngineer?.totalCount ?? tracks.length} milestones complete
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>Phase Breakdown</span>
            <BookOpen className="h-4 w-4 text-emerald-400" />
          </div>
          <p className="font-mono text-lg font-bold text-white tabular-nums">
            D1: {activeEngineer?.day1Completed ?? 0}/
            {activeEngineer?.day1Total ?? 3} · W1:{' '}
            {activeEngineer?.week1Completed ?? 0}/
            {activeEngineer?.week1Total ?? 2} · M1:{' '}
            {activeEngineer?.month1Completed ?? 0}/
            {activeEngineer?.month1Total ?? 2}
          </p>
          <p className="text-xs text-slate-400">
            Day 1 · Week 1 · Month 1 milestones
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>Remaining Ramp Time</span>
            <Clock className="h-4 w-4 text-emerald-400" />
          </div>
          <p className="font-mono text-2xl font-bold text-white tabular-nums">
            {remainingMinutes} min
          </p>
          <p className="text-xs text-slate-400">
            Estimated hands-on setup time remaining
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-slate-400">
            <span>
              {isManagerOrAdmin
                ? 'Cohort Avg Completion'
                : 'Active RBAC Clearance'}
            </span>
            <Users className="h-4 w-4 text-emerald-400" />
          </div>
          <p className="font-mono text-2xl font-bold text-emerald-400 tabular-nums">
            {isManagerOrAdmin ? `${cohortAvgCompletion}%` : activeRole}
          </p>
          <p className="text-xs text-slate-400">
            {isManagerOrAdmin
              ? `Across ${cohort.length} onboarding engineers`
              : `Self-service track (${activeEngineer?.userHandle || '@alex.chen'})`}
          </p>
        </div>
      </section>

      {feedback && (
        <div
          className={`rounded-lg border px-4 py-3 text-xs ${
            feedback.type === 'success'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-red-500/30 bg-red-500/10 text-red-300'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Main Split: Left 7-Col Interactive Checklist, Right 5-Col Manager Cohort Visibility */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Column: Interactive Day 1 / Week 1 / Month 1 Checklist */}
        <div className="lg:col-span-7 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-5 py-4">
            <div>
              <h2 className="font-display text-base font-semibold text-white">
                {activeEngineer
                  ? `${activeEngineer.displayName} (${activeEngineer.userHandle})`
                  : 'Engineering Onboarding Checklist'}
              </h2>
              <p className="text-xs text-slate-400">
                {activeEngineer?.engineerRole || 'Software Engineer'} · Click
                any checkbox to persist completion state to PostgreSQL
              </p>
            </div>

            {/* Segmented Phase Filter */}
            <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950 p-1">
              {PHASES.map((phase) => (
                <button
                  key={phase}
                  type="button"
                  onClick={() => setPhaseFilter(phase)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    phaseFilter === phase
                      ? 'bg-emerald-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {phase === 'all' ? 'All Phases' : phase}
                </button>
              ))}
            </div>
          </div>

          {loading && tracks.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-xs text-slate-400">
              Loading onboarding curriculum from PostgreSQL...
            </div>
          ) : (
            <div className="space-y-3">
              {filteredTracks.map((track) => {
                const prog = activeEngineer?.progressByTrackId[track.id];
                const isCompleted = Boolean(prog?.completed);
                const isToggling = togglingTrackId === track.id;

                return (
                  <div
                    key={track.id}
                    className={`rounded-xl border p-5 transition-colors ${
                      isCompleted
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-start gap-3.5">
                      <button
                        type="button"
                        disabled={isToggling}
                        onClick={() => handleToggle(track.id, isCompleted)}
                        aria-label={`Mark "${track.title}" as ${
                          isCompleted ? 'incomplete' : 'complete'
                        }`}
                        className="mt-0.5 text-emerald-400 hover:text-emerald-300 disabled:opacity-50 cursor-pointer shrink-0"
                      >
                        {isCompleted ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                        ) : (
                          <Circle className="h-5 w-5 text-slate-500 hover:text-slate-300" />
                        )}
                      </button>

                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3
                            className={`font-display text-sm font-semibold ${
                              isCompleted
                                ? 'line-through text-slate-400'
                                : 'text-white'
                            }`}
                          >
                            {track.title}
                          </h3>
                          <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                            {track.phase} · {track.category} ·{' '}
                            {track.estimatedMinutes}m
                          </span>
                        </div>

                        <p className="text-xs leading-relaxed text-slate-300">
                          {track.description}
                        </p>

                        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-[11px] text-slate-400">
                          <div className="flex flex-wrap items-center gap-2">
                            {track.linkedDocTitle && (
                              <>
                                <BookOpen className="h-3.5 w-3.5 text-emerald-400" />
                                <span className="text-slate-300 font-medium">
                                  Runbook: {track.linkedDocTitle}
                                </span>
                                <span aria-hidden="true">·</span>
                              </>
                            )}
                            <span className="font-mono">
                              Tier: {track.targetRole}
                            </span>
                            {isCompleted && prog?.completedAt && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono text-emerald-400 tabular-nums">
                                  Completed{' '}
                                  {new Date(
                                    prog.completedAt
                                  ).toLocaleDateString('en-US', {
                                    month: 'short',
                                    day: 'numeric',
                                  })}
                                </span>
                              </>
                            )}
                          </div>

                          {track.verificationPrompt && (
                            <button
                              type="button"
                              onClick={() =>
                                onAskMentorInPlayground(
                                  track.verificationPrompt!
                                )
                              }
                              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-[11px] font-medium text-emerald-400 transition-colors hover:border-emerald-500/50 hover:text-emerald-300 whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              <Terminal className="h-3 w-3" />
                              Ask Mentor in Playground
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Column: Manager Cohort Visibility Layer & Milestone Assignment */}
        <div className="lg:col-span-5 space-y-6">
          {isManagerOrAdmin ? (
            <>
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-display text-sm font-semibold text-white">
                      Manager Cohort Visibility ({cohort.length} Engineers)
                    </h3>
                    <p className="text-xs text-slate-400">
                      Select any engineer below to inspect or update their Day 1 / Week 1 / Month 1 checklist.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowAddForm(!showAddForm)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {showAddForm ? 'Close Form' : 'Add Milestone'}
                  </button>
                </div>

                <div className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-950">
                  {cohort.map((member) => {
                    const isSelected =
                      member.userHandle === activeEngineer?.userHandle;
                    return (
                      <button
                        key={member.userHandle}
                        type="button"
                        onClick={() => setSelectedHandle(member.userHandle)}
                        className={`w-full p-3.5 text-left transition-colors cursor-pointer space-y-2 ${
                          isSelected
                            ? 'bg-emerald-500/10'
                            : 'hover:bg-slate-900'
                        }`}
                      >
                        <div className="flex items-center justify-between text-xs">
                          <div>
                            <span className="font-semibold text-white">
                              {member.displayName}
                            </span>
                            <span className="ml-1.5 font-mono text-emerald-400">
                              {member.userHandle}
                            </span>
                            <p className="text-[11px] text-slate-400">
                              {member.engineerRole}
                            </p>
                          </div>
                          <div className="text-right font-mono tabular-nums">
                            <span className="text-sm font-bold text-white">
                              {member.completionRate}%
                            </span>
                            <p className="text-[11px] text-slate-400">
                              {member.completedCount}/{member.totalCount} done
                            </p>
                          </div>
                        </div>

                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                          <div
                            className="h-full bg-emerald-500 transition-all"
                            style={{ width: `${member.completionRate}%` }}
                          />
                        </div>

                        <div className="flex items-center justify-between font-mono text-[10px] text-slate-400 tabular-nums">
                          <span>
                            Day 1: {member.day1Completed}/{member.day1Total}
                          </span>
                          <span>
                            Week 1: {member.week1Completed}/{member.week1Total}
                          </span>
                          <span>
                            Month 1: {member.month1Completed}/
                            {member.month1Total}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {showAddForm && (
                <form
                  onSubmit={handleCreateSubmit}
                  className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-4"
                >
                  <h3 className="font-display text-sm font-semibold text-white">
                    Assign New Onboarding Milestone
                  </h3>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Onboarding Phase
                      </label>
                      <select
                        value={newPhase}
                        onChange={(e) =>
                          setNewPhase(e.target.value as OnboardingPhase)
                        }
                        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                      >
                        <option value="Day 1">Day 1</option>
                        <option value="Week 1">Week 1</option>
                        <option value="Month 1">Month 1</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Estimated Minutes
                      </label>
                      <input
                        type="number"
                        min={5}
                        max={240}
                        value={newMinutes}
                        onChange={(e) => setNewMinutes(Number(e.target.value))}
                        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white font-mono"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Milestone Title
                    </label>
                    <input
                      type="text"
                      required
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      placeholder="e.g. Configure PagerDuty On-Call Shadowing"
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder:text-slate-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Description &amp; Acceptance Criteria
                    </label>
                    <textarea
                      rows={3}
                      required
                      value={newDesc}
                      onChange={(e) => setNewDesc(e.target.value)}
                      placeholder="Describe what the new hire needs to configure or verify..."
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder:text-slate-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Linked Runbook (Optional)
                      </label>
                      <select
                        value={newLinkedDoc}
                        onChange={(e) => setNewLinkedDoc(e.target.value)}
                        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                      >
                        <option value="">None</option>
                        {documents.map((d) => (
                          <option key={d.id} value={d.title}>
                            {d.title}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Category &amp; Role Tier
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={newCategory}
                          onChange={(e) => setNewCategory(e.target.value)}
                          placeholder="Category"
                          className="w-1/2 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-white"
                        />
                        <select
                          value={newTargetRole}
                          onChange={(e) =>
                            setNewTargetRole(e.target.value as RbacRole)
                          }
                          className="w-1/2 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-white"
                        >
                          <option value="Engineer">Engineer</option>
                          <option value="Manager">Manager</option>
                          <option value="Admin">Admin</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Playground Verification Prompt (Optional)
                    </label>
                    <input
                      type="text"
                      value={newPrompt}
                      onChange={(e) => setNewPrompt(e.target.value)}
                      placeholder="e.g. How do I shadow an on-call shift and roll back staging?"
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder:text-slate-500"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={creatingTrack}
                    className="w-full rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-50 cursor-pointer"
                  >
                    {creatingTrack
                      ? 'Saving Milestone to PostgreSQL...'
                      : 'Save & Assign Milestone to Cohort'}
                  </button>
                </form>
              )}
            </>
          ) : (
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-3">
              <div className="flex items-center gap-2 text-emerald-400">
                <Lock className="h-4 w-4" />
                <h3 className="font-display text-sm font-semibold text-white">
                  Engineer Self-Service View
                </h3>
              </div>
              <p className="text-xs leading-relaxed text-slate-300">
                You are currently viewing your personal onboarding track with{' '}
                <strong className="font-mono text-white">Engineer</strong> RBAC
                clearance. You can check off your own Day 1, Week 1, and Month 1
                milestones and launch guided verification queries in the RAG
                Playground.
              </p>
              <p className="text-xs text-slate-400">
                Switch to <strong className="text-white">Manager</strong> or{' '}
                <strong className="text-white">Admin</strong> in the top header
                bar to unlock the multi-engineer{' '}
                <strong className="text-white">
                  Manager Cohort Visibility Matrix
                </strong>{' '}
                and assign new curriculum milestones.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
