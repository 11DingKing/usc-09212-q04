// 内存投影：由只追加日志重放得到。所有业务变更先写日志、再应用到投影，
// 因此重启后重放同一日志必然得到同一状态。
export function createState() {
  return {
    identities: new Map(), // identityId -> { identityId, displayName, org, token, createdAt }
    resources: new Map(), // resourceId -> { resourceId, lab, description, createdAt }
    projects: new Map(), // projectId -> project
    bookings: new Map(), // bookingId -> booking（跨项目索引，用于资源占用冲突检测）
    records: [], // 全量审计记录
  };
}

function newProject(record, p) {
  return {
    id: p.projectId,
    name: p.name,
    buyerId: p.buyerIdentityId,
    createdAt: record.receivedAt,
    members: new Map([[p.buyerIdentityId, "buyer"]]),
    baselineDraft: null, // 买方提交但未封存的基线
    baselineSealed: null, // 已封存基线（含 hash，封存后不可改）
    robots: new Map(), // robotId -> { robotId, model, currentFirmware, firmwares: Map }
    scripts: new Map(), // scriptId -> { scriptId, latestHash, versions: Map(hash -> {version, hash, content}) }
    rounds: [], // [{ number, robotId, firmwareVersion, scriptHash, scriptId, status, openedAt, runIds }]
    runs: new Map(), // runId -> run
    bookings: new Map(), // bookingId -> booking
    disputes: new Map(), // disputeId -> dispute
    reportSnapshots: new Map(), // snapshotId -> { snapshotId, contentHash, report, generatedAt, generatedBy }
  };
}

export function applyRecord(state, record) {
  state.records.push(record);
  const p = record.payload ?? {};
  const project = p.projectId ? state.projects.get(p.projectId) : null;

  switch (record.type) {
    case "identity_created":
      state.identities.set(p.identityId, {
        identityId: p.identityId,
        displayName: p.displayName ?? null,
        org: p.org ?? null,
        token: p.token,
        createdAt: record.receivedAt,
      });
      break;

    case "resource_registered":
      state.resources.set(p.resourceId, {
        resourceId: p.resourceId,
        lab: p.lab ?? null,
        description: p.description ?? null,
        createdAt: record.receivedAt,
      });
      break;

    case "project_created":
      state.projects.set(p.projectId, newProject(record, p));
      break;

    case "member_granted":
      project?.members.set(p.identityId, p.role);
      break;

    case "member_revoked":
      project?.members.delete(p.identityId);
      break;

    case "baseline_submitted":
      if (project) {
        project.baselineDraft = {
          siteConstraints: p.baseline.siteConstraints,
          successCriteria: p.baseline.successCriteria,
          classificationWindowMs: p.baseline.classificationWindowMs ?? null,
          submittedAt: record.receivedAt,
        };
      }
      break;

    case "baseline_sealed":
      if (project?.baselineDraft) {
        project.baselineSealed = {
          ...project.baselineDraft,
          hash: p.hash,
          sealedAt: record.receivedAt,
        };
      }
      break;

    case "robot_registered":
      if (project) {
        const firmwares = new Map();
        firmwares.set(p.firmwareVersion, {
          firmwareVersion: p.firmwareVersion,
          deviceSecret: p.deviceSecret,
          registeredAt: record.receivedAt,
        });
        project.robots.set(p.robotId, {
          robotId: p.robotId,
          model: p.model,
          currentFirmware: p.firmwareVersion,
          firmwares,
        });
      }
      break;

    case "firmware_registered": {
      const robot = project?.robots.get(p.robotId);
      if (robot) {
        robot.firmwares.set(p.firmwareVersion, {
          firmwareVersion: p.firmwareVersion,
          deviceSecret: p.deviceSecret,
          registeredAt: record.receivedAt,
        });
        robot.currentFirmware = p.firmwareVersion;
      }
      break;
    }

    case "script_registered": {
      if (project) {
        let script = project.scripts.get(p.scriptId);
        if (!script) {
          script = { scriptId: p.scriptId, latestHash: null, versions: new Map() };
          project.scripts.set(p.scriptId, script);
        }
        script.versions.set(p.hash, {
          version: p.version,
          hash: p.hash,
          content: p.content,
          registeredAt: record.receivedAt,
        });
        script.latestHash = p.hash;
      }
      break;
    }

    case "booking_created": {
      const booking = {
        bookingId: p.bookingId,
        projectId: p.projectId,
        resourceId: p.resourceId,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
        purpose: p.purpose ?? null,
        status: "active",
        createdBy: record.actorId,
        createdAt: record.receivedAt,
      };
      project?.bookings.set(p.bookingId, booking);
      state.bookings.set(p.bookingId, booking);
      break;
    }

    case "booking_cancelled": {
      const booking = state.bookings.get(p.bookingId);
      if (booking) {
        booking.status = "cancelled";
        booking.cancelledAt = record.receivedAt;
        booking.cancelReason = p.reason ?? null;
      }
      break;
    }

    case "round_opened": {
      if (project) {
        for (const number of p.supersededRounds ?? []) {
          const old = project.rounds[number - 1];
          if (old) old.status = "superseded";
        }
        project.rounds.push({
          number: p.roundNumber,
          robotId: p.robotId,
          firmwareVersion: p.firmwareVersion,
          scriptHash: p.scriptHash,
          scriptId: p.scriptId,
          status: "open",
          openedAt: record.receivedAt,
          runIds: [],
        });
      }
      break;
    }

    case "run_started": {
      if (project) {
        project.runs.set(p.runId, {
          runId: p.runId,
          projectId: p.projectId,
          roundNumber: p.roundNumber,
          robotId: p.robotId,
          firmwareVersion: p.firmwareVersion,
          scriptHash: p.scriptHash,
          scriptId: p.scriptId,
          resourceId: p.resourceId,
          bookingId: p.bookingId,
          labId: record.actorId,
          status: "running", // running -> interrupted -> running -> completed
          segments: [{ n: 1, events: [], cutAtSeq: null }],
          eventIds: new Set(),
          interruptions: [],
          startedAt: record.receivedAt,
          completedAt: null,
        });
        project.rounds[p.roundNumber - 1]?.runIds.push(p.runId);
      }
      break;
    }

    case "run_event_appended": {
      const run = project?.runs.get(p.runId);
      if (run) {
        const segment = run.segments[p.segment - 1];
        segment?.events.push(p.event);
        run.eventIds.add(p.event.eventId);
      }
      break;
    }

    case "run_interrupted": {
      const run = project?.runs.get(p.runId);
      if (run) {
        run.status = "interrupted";
        run.interruptions.push({ reason: p.reason ?? null, at: record.receivedAt });
      }
      break;
    }

    case "run_resumed": {
      const run = project?.runs.get(p.runId);
      if (run) {
        // 截断旧分段：检查点之后的事件被标记为"被取代"，但记录原样保留在日志中。
        const from = run.segments[p.fromSegment - 1];
        if (from) from.cutAtSeq = p.checkpointSeq;
        run.segments.push({ n: p.newSegment, events: [], cutAtSeq: null });
        run.status = "running";
      }
      break;
    }

    case "run_completed": {
      const run = project?.runs.get(p.runId);
      if (run) {
        run.status = "completed";
        run.completedAt = record.receivedAt;
      }
      break;
    }

    case "dispute_opened":
      project?.disputes.set(p.disputeId, {
        disputeId: p.disputeId,
        subjectType: p.subjectType,
        subjectId: p.subjectId,
        claim: p.claim,
        status: "open",
        openedBy: record.actorId,
        openedAt: record.receivedAt,
        resolution: null,
        outcome: null,
        resolvedAt: null,
      });
      break;

    case "dispute_resolved": {
      const dispute = project?.disputes.get(p.disputeId);
      if (dispute) {
        dispute.status = "resolved";
        dispute.resolution = p.resolution;
        dispute.outcome = p.outcome ?? null;
        dispute.resolvedAt = record.receivedAt;
      }
      break;
    }

    case "report_snapshot_created":
      project?.reportSnapshots.set(p.snapshotId, {
        snapshotId: p.snapshotId,
        contentHash: p.contentHash,
        report: p.report,
        generatedAt: record.receivedAt,
        generatedBy: record.actorId,
      });
      break;

    default:
      break;
  }
}

export function buildState(records) {
  const state = createState();
  for (const record of records) {
    applyRecord(state, record);
  }
  return state;
}

export function currentSegment(run) {
  return run.segments[run.segments.length - 1];
}

export function allEvents(run) {
  return run.segments.flatMap((segment) => segment.events);
}

// 有效事件链：检查点重试后被截断分段中序号大于截断点的事件不再生效，
// 但仍保留在日志与运行详情中（可审计，不可挑选性删除）。
export function effectiveEvents(run) {
  return run.segments.flatMap((segment) =>
    segment.events.filter((event) => segment.cutAtSeq == null || event.seq <= segment.cutAtSeq),
  );
}

export function isSuperseded(segment, event) {
  return segment.cutAtSeq != null && event.seq > segment.cutAtSeq;
}

export function runView(run, { includeEvents = true } = {}) {
  const effective = effectiveEvents(run).length;
  const total = allEvents(run).length;
  const segments = run.segments.map((segment) => ({
    segment: segment.n,
    cutAtSeq: segment.cutAtSeq,
    eventCount: segment.events.length,
    events: includeEvents
      ? segment.events.map((event) => ({ ...event, superseded: isSuperseded(segment, event) }))
      : undefined,
  }));
  return {
    runId: run.runId,
    projectId: run.projectId,
    roundNumber: run.roundNumber,
    robotId: run.robotId,
    firmwareVersion: run.firmwareVersion,
    scriptId: run.scriptId,
    scriptHash: run.scriptHash,
    resourceId: run.resourceId,
    bookingId: run.bookingId,
    labId: run.labId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    interruptions: run.interruptions,
    currentSegment: currentSegment(run).n,
    effectiveEventCount: effective,
    supersededEventCount: total - effective,
    segments,
  };
}

export function robotView(robot) {
  return {
    robotId: robot.robotId,
    model: robot.model,
    currentFirmware: robot.currentFirmware,
    firmwares: [...robot.firmwares.values()].map((firmware) => ({
      firmwareVersion: firmware.firmwareVersion,
      registeredAt: firmware.registeredAt,
      hasDeviceSecret: Boolean(firmware.deviceSecret),
    })),
  };
}

export function scriptView(script) {
  return {
    scriptId: script.scriptId,
    latestHash: script.latestHash,
    versions: [...script.versions.values()].map((version) => ({
      version: version.version,
      hash: version.hash,
      registeredAt: version.registeredAt,
    })),
  };
}

export function projectView(project) {
  return {
    projectId: project.id,
    name: project.name,
    buyerId: project.buyerId,
    createdAt: project.createdAt,
    members: [...project.members.entries()].map(([identityId, role]) => ({ identityId, role })),
    baseline: project.baselineSealed
      ? { status: "sealed", hash: project.baselineSealed.hash, sealedAt: project.baselineSealed.sealedAt }
      : project.baselineDraft
        ? { status: "draft", submittedAt: project.baselineDraft.submittedAt }
        : { status: "missing" },
    robotCount: project.robots.size,
    scriptCount: project.scripts.size,
    roundCount: project.rounds.length,
    runCount: project.runs.size,
    openDisputes: [...project.disputes.values()].filter((dispute) => dispute.status === "open").length,
  };
}
