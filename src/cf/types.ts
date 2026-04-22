export interface CfProblem {
  contestId?: number;
  index: string;
  name: string;
  rating?: number;
  tags: string[];
}

export interface CfProblemResult {
  points: number;
  rejectedAttemptCount: number;
  type: 'PRELIMINARY' | 'FINAL';
  bestSubmissionTimeSeconds?: number;
}

export interface CfParty {
  contestId?: number;
  members: { handle: string }[];
  participantType:
    | 'CONTESTANT'
    | 'PRACTICE'
    | 'VIRTUAL'
    | 'MANAGER'
    | 'OUT_OF_COMPETITION';
  teamName?: string;
  ghost: boolean;
}

export interface CfStandingsRow {
  party: CfParty;
  rank: number;
  points: number;
  penalty: number;
  successfulHackCount: number;
  unsuccessfulHackCount: number;
  problemResults: CfProblemResult[];
}

export interface CfContest {
  id: number;
  name: string;
  type: 'CF' | 'IOI' | 'ICPC';
  phase: 'BEFORE' | 'CODING' | 'PENDING_SYSTEM_TEST' | 'SYSTEM_TEST' | 'FINISHED';
  durationSeconds: number;
  startTimeSeconds?: number;
}

export interface CfStandings {
  contest: CfContest;
  problems: CfProblem[];
  rows: CfStandingsRow[];
}

export interface CfUserInfo {
  handle: string;
  rating?: number;
  maxRating?: number;
}

export interface CfRatingChange {
  contestId: number;
  handle: string;
  rank: number;
  oldRating: number;
  newRating: number;
}
