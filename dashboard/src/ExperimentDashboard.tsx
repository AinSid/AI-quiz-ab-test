import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import summaryData from "./data/experiment-summary.json";

type ArmKey = "control" | "personalized_quiz";
type MetricKey = "attempt" | "completion" | "retention";

type Comparison = {
  control: { success: number; total: number; rate: number };
  treatment: { success: number; total: number; rate: number };
  difference: number;
  z: number;
  pValue: number;
  ci95: [number, number];
  significant: boolean;
};

type ParticleBin = {
  variant: ArmKey;
  history: "low" | "higher";
  attempted: boolean;
  completed: boolean;
  retained: boolean;
  users: number;
  particles: number;
};

type ExperimentSummary = typeof summaryData & {
  metrics: typeof summaryData.metrics & Record<MetricKey, Comparison>;
  particleBins: ParticleBin[];
};

const data = summaryData as ExperimentSummary;
const metricOrder: MetricKey[] = ["attempt", "completion", "retention"];

const metricContent: Record<MetricKey, { label: string; eyebrow: string; description: string }> = {
  attempt: {
    label: "Attempt",
    eyebrow: "Primary metric",
    description: "Students who started at least one quiz",
  },
  completion: {
    label: "Completion",
    eyebrow: "Guardrail",
    description: "Quiz starters who completed at least one quiz",
  },
  retention: {
    label: "Retention",
    eyebrow: "Guardrail",
    description: "Students active in the final seven-day window",
  },
};

function percent(value: number, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

function pp(value: number, digits = 1, includePlus = true) {
  const scaled = value * 100;
  const sign = includePlus && scaled > 0 ? "+" : "";
  return `${sign}${scaled.toFixed(digits)}pp`;
}

function formatP(value: number) {
  if (value < 0.001) return "p < 0.001";
  return `p = ${value.toFixed(2)}`;
}

function mulberry32(seed: number) {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function easeInOutCubic(value: number) {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

type Particle = ParticleBin & {
  startX: number;
  startY: number;
  cohortX: number;
  cohortY: number;
  targetX: number;
  targetY: number;
  flicker: number;
  delta: Partial<Record<MetricKey, "gain" | "loss">>;
};

function makeParticles(): Particle[] {
  const random = mulberry32(20260609);
  const bins = data.particleBins;
  const totals: Record<ArmKey, number> = {
    control: bins.filter((bin) => bin.variant === "control").reduce((sum, bin) => sum + bin.particles, 0),
    personalized_quiz: bins.filter((bin) => bin.variant === "personalized_quiz").reduce((sum, bin) => sum + bin.particles, 0),
  };
  const armIndex: Record<ArmKey, number> = { control: 0, personalized_quiz: 0 };
  const particles: Particle[] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  let globalIndex = 0;

  for (const bin of bins) {
    for (let index = 0; index < bin.particles; index += 1) {
      const localIndex = armIndex[bin.variant]++;
      const armProgress = (localIndex + 0.5) / totals[bin.variant];
      const armAngle = localIndex * goldenAngle + (bin.variant === "control" ? 0.4 : 1.3);
      const armRadius = Math.sqrt(armProgress);
      const centerX = bin.variant === "control" ? 0.29 : 0.71;

      const cohortProgress = (globalIndex + 0.5) / (totals.control + totals.personalized_quiz);
      const cohortAngle = globalIndex * goldenAngle;
      const cohortRadius = Math.sqrt(cohortProgress);

      particles.push({
        ...bin,
        startX: random() < 0.5 ? -0.08 - random() * 0.12 : 1.08 + random() * 0.12,
        startY: 0.08 + random() * 0.84,
        cohortX: 0.5 + Math.cos(cohortAngle) * cohortRadius * 0.22,
        cohortY: 0.52 + Math.sin(cohortAngle) * cohortRadius * 0.38,
        targetX: centerX + Math.cos(armAngle) * armRadius * 0.2,
        targetY: 0.54 + Math.sin(armAngle) * armRadius * 0.36,
        flicker: 0.82 + random() * 0.18,
        delta: {},
      });
      globalIndex += 1;
    }
  }

  const markDelta = (
    candidates: Particle[],
    count: number,
    metric: MetricKey,
    direction: "gain" | "loss",
  ) => {
    for (let index = 0; index < count; index += 1) {
      const candidateIndex = Math.floor(((index + 0.5) * candidates.length) / count);
      candidates[candidateIndex].delta[metric] = direction;
    }
  };

  markDelta(
    particles.filter((particle) => particle.variant === "personalized_quiz" && particle.attempted),
    Math.round((data.metrics.attempt.difference * data.arms.personalized_quiz.users) / data.experiment.particleScale),
    "attempt",
    "gain",
  );
  markDelta(
    particles.filter((particle) => particle.variant === "personalized_quiz" && particle.attempted && !particle.completed),
    Math.round((Math.abs(data.metrics.completion.difference) * data.metrics.completion.treatment.total) / data.experiment.particleScale),
    "completion",
    "loss",
  );

  return particles;
}

function ParticleField({ metric, replayKey, onIntroComplete }: { metric: MetricKey; replayKey: number; onIntroComplete: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const particles = useMemo(makeParticles, []);
  const completionRef = useRef(onIntroComplete);
  completionRef.current = onIntroComplete;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    let frame = 0;
    let start = performance.now();
    let width = 0;
    let height = 0;
    let visible = !document.hidden;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reducedMotion ? 0 : 3900;

    const resize = () => {
      const bounds = container.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const isActive = (particle: Particle) => {
      if (metric === "attempt") return particle.attempted;
      if (metric === "completion") return particle.completed;
      return particle.retained;
    };

    const draw = (elapsed: number) => {
      context.clearRect(0, 0, width, height);
      const gatherProgress = reducedMotion ? 1 : easeInOutCubic(Math.min(1, elapsed / 900));
      const splitProgress = reducedMotion ? 1 : easeInOutCubic(Math.max(0, Math.min(1, (elapsed - 850) / 1450)));
      const lightProgress = reducedMotion ? 1 : easeInOutCubic(Math.max(0, Math.min(1, (elapsed - 2200) / 1200)));
      const radius = width < 680 ? 1.15 : 1.35;

      context.globalCompositeOperation = "source-over";
      for (const particle of particles) {
        const gatheredX = particle.startX + (particle.cohortX - particle.startX) * gatherProgress;
        const gatheredY = particle.startY + (particle.cohortY - particle.startY) * gatherProgress;
        const x = gatheredX + (particle.targetX - gatheredX) * splitProgress;
        const y = gatheredY + (particle.targetY - gatheredY) * splitProgress;
        const excluded = metric === "completion" && !particle.attempted;
        const active = isActive(particle);
        const delta = particle.delta[metric];
        const baseAlpha = excluded ? 0.035 : splitProgress < 0.55 ? 0.22 : 0.13;
        const activeAlpha = baseAlpha + (delta ? lightProgress * 0.9 : active && !excluded ? lightProgress * 0.72 * particle.flicker : 0);
        const color = delta === "gain"
          ? `rgba(195, 255, 101, ${activeAlpha})`
          : delta === "loss"
            ? `rgba(255, 127, 104, ${activeAlpha})`
            : particle.variant === "control"
              ? active ? `rgba(65, 226, 239, ${activeAlpha})` : `rgba(65, 226, 239, ${baseAlpha})`
              : active ? `rgba(171, 125, 255, ${activeAlpha})` : `rgba(171, 125, 255, ${baseAlpha})`;
        const particleSize = delta && lightProgress > 0.5 ? radius * 2.35 : radius;
        context.fillStyle = color;
        context.fillRect(x * width - particleSize / 2, y * height - particleSize / 2, particleSize, particleSize);
      }

      if (splitProgress > 0.45) {
        const alpha = Math.min(1, (splitProgress - 0.45) * 2) * 0.5;
        context.strokeStyle = `rgba(255,255,255,${0.08 * alpha})`;
        context.setLineDash([4, 7]);
        context.beginPath();
        context.moveTo(width / 2, height * 0.18);
        context.lineTo(width / 2, height * 0.88);
        context.stroke();
        context.setLineDash([]);
      }
    };

    const tick = (now: number) => {
      if (!visible) return;
      const elapsed = duration === 0 ? duration : now - start;
      draw(duration === 0 ? 4000 : elapsed);
      if (duration > 0 && elapsed < duration) {
        frame = requestAnimationFrame(tick);
      } else {
        completionRef.current();
      }
    };

    const onVisibility = () => {
      visible = !document.hidden;
      if (visible) {
        start = performance.now() - Math.min(duration, performance.now() - start);
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(tick);
      } else {
        cancelAnimationFrame(frame);
      }
    };

    resize();
    const resizeObserver = new ResizeObserver(() => {
      resize();
      draw(duration === 0 ? 4000 : performance.now() - start);
    });
    resizeObserver.observe(container);
    document.addEventListener("visibilitychange", onVisibility);
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [metric, particles, replayKey]);

  return (
    <div className="particle-field" ref={containerRef}>
      <div className="particle-glow particle-glow-control" />
      <div className="particle-glow particle-glow-treatment" />
      <canvas
        ref={canvasRef}
        aria-label={`${data.experiment.cleanUsers.toLocaleString()} experiment participants shown as aggregate particles, split between control and personalized quiz groups.`}
      />
    </div>
  );
}

function ArrowIcon() {
  return <span aria-hidden="true">↗</span>;
}

function MetricPanel({ metric }: { metric: MetricKey }) {
  const comparison = data.metrics[metric];
  return (
    <div className="hero-rates" aria-live="polite">
      <div className="hero-rate hero-rate-control">
        <span className="rate-label"><i />Control</span>
        <strong>{percent(comparison.control.rate)}</strong>
        <small>{comparison.control.success.toLocaleString()} / {comparison.control.total.toLocaleString()}</small>
      </div>
      <div className="rate-delta">
        <span>{metricContent[metric].eyebrow}</span>
        <strong className={comparison.difference < 0 ? "negative" : comparison.significant ? "positive" : "neutral"}>
          {pp(comparison.difference, metric === "retention" ? 2 : 1)}
        </strong>
        <small>{comparison.significant ? formatP(comparison.pValue) : "not significant"}</small>
      </div>
      <div className="hero-rate hero-rate-treatment">
        <span className="rate-label"><i />Personalized</span>
        <strong>{percent(comparison.treatment.rate)}</strong>
        <small>{comparison.treatment.success.toLocaleString()} / {comparison.treatment.total.toLocaleString()}</small>
      </div>
    </div>
  );
}

const outcomeCards = [
  { label: "Quiz attempts", value: "+3.1pp", note: "Significant, p < 0.001", tone: "up" },
  { label: "Completion among starters", value: "−2.0pp", note: "Significant, p < 0.001", tone: "down" },
  { label: "Overall completion", value: "+1.6pp", note: "Significant, p < 0.001", tone: "up" },
  { label: "7-day retention", value: "+0.18pp", note: "No detectable change, p = 0.62", tone: "flat" },
];

function ComparisonRow({ label, note, comparison }: { label: string; note: string; comparison: Comparison }) {
  const max = 1;
  return (
    <article className="comparison-row">
      <header>
        <div>
          <span>{label}</span>
          <small>{note}</small>
        </div>
        <div className={`significance ${comparison.significant ? "is-significant" : "is-flat"}`}>
          {comparison.significant ? "SIGNIFICANT" : "NO DETECTABLE CHANGE"}
        </div>
      </header>
      <div className="bar-pair">
        <div className="bar-line">
          <span>Control</span>
          <div className="bar-track"><i className="bar-control" style={{ width: `${(comparison.control.rate / max) * 100}%` }} /></div>
          <strong>{percent(comparison.control.rate)}</strong>
        </div>
        <div className="bar-line">
          <span>Personalized</span>
          <div className="bar-track"><i className="bar-treatment" style={{ width: `${(comparison.treatment.rate / max) * 100}%` }} /></div>
          <strong>{percent(comparison.treatment.rate)}</strong>
        </div>
      </div>
      <footer>
        <strong className={comparison.difference < 0 ? "negative" : comparison.significant ? "positive" : "neutral"}>
          {pp(comparison.difference, label.includes("Retention") ? 2 : 1)}
        </strong>
        <span>95% CI {pp(comparison.ci95[0], 2, false)} to {pp(comparison.ci95[1], 2, true)}</span>
      </footer>
    </article>
  );
}

function SegmentCard({ kind }: { kind: "low" | "higher" }) {
  const segment = data.segments[kind];
  const isHigher = kind === "higher";
  return (
    <article className={`segment-card ${isHigher ? "segment-card-featured" : ""}`}>
      <div className="segment-card-topline">
        <span>{isHigher ? "02" : "01"}</span>
        <span>{segment.users.toLocaleString()} users</span>
      </div>
      <h3>{isHigher ? "Old users" : "New users"}</h3>
      <p>{isHigher ? "These students had enough past activity for the quiz to draw on." : "These students had very little past activity, so the quiz had less to work with."}</p>
      <div className="segment-lift">
        <strong>{pp(segment.attempt.difference)}</strong>
        <span>attempt lift</span>
      </div>
      <div className="segment-rates">
        <div><span>Control</span><strong>{percent(segment.attempt.control.rate)}</strong></div>
        <div className="segment-arrow" aria-hidden="true">→</div>
        <div><span>Personalized</span><strong>{percent(segment.attempt.treatment.rate)}</strong></div>
      </div>
      <div className={`segment-verdict ${segment.attempt.significant ? "is-significant" : "is-flat"}`}>
        <i /> {segment.attempt.significant ? "Significant result" : "No reliable lift"}, {formatP(segment.attempt.pValue)}
      </div>
    </article>
  );
}

export default function ExperimentDashboard() {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [metric, setMetric] = useState<MetricKey>("attempt");
  const [replayKey, setReplayKey] = useState(0);
  const [introComplete, setIntroComplete] = useState(false);
  const [validityOpen, setValidityOpen] = useState(() => !window.matchMedia("(max-width: 640px)").matches);
  const completeIntro = useCallback(() => setIntroComplete(true), []);

  useEffect(() => {
    if (!aboutOpen && !profileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAboutOpen(false);
        setProfileOpen(false);
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [aboutOpen, profileOpen]);

  const replay = () => {
    setMetric("attempt");
    setIntroComplete(false);
    setReplayKey((key) => key + 1);
  };

  return (
    <main className="experience-entered">
      <section className="hero" id="top">
        <nav className="top-nav" aria-label="Primary navigation">
          <div className="nav-start">
            <a className="brand" href="#top"><i /> AI Quiz A/B Test</a>
          </div>
          <div className="nav-actions">
            <button className="nav-about" type="button" onClick={() => setAboutOpen(true)}>Explore</button>
            <button className="nav-about" type="button" onClick={() => setProfileOpen(true)}>About Me</button>
            <a className="nav-link" href="https://github.com/AinSid/AI-quiz-ab-test" target="_blank" rel="noreferrer">
              View analysis <ArrowIcon />
            </a>
          </div>
        </nav>

        <div className="hero-copy hero-intro">
          <span className="eyebrow"><i /> A/B test: EdTech Platform</span>
          <h1>This study explores whether offering students a <em>personalized AI quiz</em> makes them more likely to start a quiz, compared with a standard quiz.</h1>
          <p>We ran an A/B test with 64,888 students. One group saw the standard quiz. The other saw an AI-generated quiz built from questions they got wrong, bookmarked, or revisited.</p>
        </div>

        <div className={`particle-stage ${introComplete ? "intro-complete" : ""}`}>
          <div className="particle-toolbar">
            <div className="metric-tabs" role="tablist" aria-label="Outcome shown in the particle field">
              {metricOrder.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={metric === key}
                  className={metric === key ? "is-active" : ""}
                  onClick={() => setMetric(key)}
                >
                  {metricContent[key].label}
                </button>
              ))}
            </div>
            <button className="replay-button" type="button" onClick={replay} aria-label="Replay experiment animation">↻ Replay</button>
          </div>
          <div className="arm-label arm-label-control"><i /> Control</div>
          <div className="arm-label arm-label-treatment"><i /> Personalized AI</div>
          <div className={`metric-delta-key metric-delta-key-${metric}`}>
            <i />
            {metric === "attempt" && "Bright lime particles isolate the additional +3.1pp of quiz attempts"}
            {metric === "completion" && "Coral particles isolate the additional 2.0pp completion drop"}
            {metric === "retention" && "The two rates overlap: no reliable retention difference was detected"}
          </div>
          <ParticleField metric={metric} replayKey={replayKey} onIntroComplete={completeIntro} />
          <MetricPanel metric={metric} />
          <div className="particle-caption">
            <span>{metricContent[metric].description}</span>
            <span>1 particle ≈ {data.experiment.particleScale} participants</span>
          </div>
        </div>

        <div className="hero-result">
          <span className="eyebrow"><i /> What the experiment found</span>
          <h2>Personalized quizzes increased<br />the overall attempt rate.<br /><em>Old users saw most of the increase.</em></h2>
          <p>The attempt rate rose by <strong>3.1 percentage points</strong> overall. New users saw no reliable increase, and completion among students who started a quiz fell by 2.0 points.</p>
        </div>
        <a className="scroll-cue" href="#outcomes"><span>Explore the result</span><i aria-hidden="true">↓</i></a>
      </section>

      <section className="outcome-strip" id="outcomes" aria-label="Experiment outcomes">
        {outcomeCards.map((card, index) => (
          <article key={card.label}>
            <span className="card-index">0{index + 1}</span>
            <span className="card-label">{card.label}</span>
            <strong className={card.tone}>{card.value}</strong>
            <small>{card.note}</small>
          </article>
        ))}
      </section>

      <section className="story-section tradeoff-section">
        <div className="section-heading">
          <span className="section-number"><strong>01</strong><span>What changed</span></span>
          <h2>More students started quizzes.<br /><em>Fewer starters finished.</em></h2>
          <p>Personalization brought more students into a quiz. A smaller share of starters finished. Even so, the larger number of starts meant more students completed a quiz overall.</p>
        </div>
        <div className="comparison-board">
          <ComparisonRow label="Attempt rate" note="All assigned users" comparison={data.metrics.attempt} />
          <ComparisonRow label="Completion among starters" note="Conditional on starting a quiz" comparison={data.metrics.completion} />
          <ComparisonRow label="Overall completion" note="All assigned users" comparison={data.metrics.overallCompletion as Comparison} />
          <ComparisonRow label="7-day retention" note="All assigned users" comparison={data.metrics.retention} />
        </div>
      </section>

      <section className="story-section history-section">
        <div className="section-heading section-heading-split">
          <div>
            <span className="section-number"><strong>02</strong><span>Who benefited</span></span>
            <h2>Old users responded.<br /><em>New users barely changed.</em></h2>
          </div>
          <p>Old users had enough past activity for the quiz to personalize around. Their attempt rate rose 3.6 points. New users rose only 1.1 points, which was too small to separate from chance.</p>
        </div>
        <div className="segment-grid">
          <SegmentCard kind="low" />
          <SegmentCard kind="higher" />
        </div>
        <div className="segment-definition">
          <span>SEGMENT DEFINITION</span>
          <p><strong>New users</strong> had answered fewer than 15 questions and saved fewer than 3 bookmarks before the test. Everyone else is shown as an <strong>old user</strong>. This split was chosen during the analysis, so the segment result is exploratory.</p>
        </div>
      </section>

      <section className="decision-section">
        <div className="decision-orbit" aria-hidden="true"><i /><i /><i /></div>
        <span className="section-number"><strong>03</strong><span>Rollout decision</span></span>
        <div className="decision-verdict"><span>DECISION</span><strong>Limited rollout</strong></div>
        <h2>Launch it for old users,<br /><em>not everyone.</em></h2>
        <p className="decision-lede">The feature is worth shipping to students with enough history. It still needs work before a full launch.</p>
        <div className="decision-steps">
          <article><span>01</span><h3>Start with old users</h3><p>Release personalization where past activity supports a reliable 3.6 point increase in quiz attempts.</p></article>
          <article><span>02</span><h3>Work on completion</h3><p>Review quiz difficulty and learn why more starters quit before finishing.</p></article>
          <article><span>03</span><h3>Design for new users</h3><p>Build an experience that needs less history, then test it over a longer retention window.</p></article>
        </div>
      </section>

      <section className="analysis-section">
        <div className="section-heading section-heading-split">
          <div>
            <span className="section-number"><strong>04</strong><span>Under the hood</span></span>
            <h2>How reliable are<br /><em>these results?</em></h2>
          </div>
          <p>The sample was large, the groups were balanced, and the main result was statistically clear. These checks show what the test supports and where the evidence stops.</p>
        </div>
        <div className="analysis-details">
          <details open={validityOpen} onToggle={(event) => setValidityOpen(event.currentTarget.open)}>
            <summary><span>01</span><strong>Experiment validity</strong><small>Randomization and baseline balance</small><i>+</i></summary>
            <div className="detail-content detail-grid">
              <div><span>Final sample</span><strong>{data.experiment.cleanUsers.toLocaleString()}</strong><p>{data.experiment.removedImpossible} impossible rows and {data.experiment.removedDuplicates} duplicates removed.</p></div>
              <div><span>Allocation</span><strong>49.57 / 50.43</strong><p>SRM check: χ² = {data.validity.sampleRatio.chiSquare.toFixed(2)}, p = {data.validity.sampleRatio.pValue.toFixed(3)}; passed the pre-set 0.001 alert threshold.</p></div>
              <div><span>Baseline balance</span><strong>Max |SMD| = 0.015</strong><p>Prior questions, bookmarks, repeated lectures, and recent sessions were balanced between arms.</p></div>
            </div>
          </details>
          <details>
            <summary><span>02</span><strong>Power and sensitivity</strong><small>Could the test detect a meaningful effect?</small><i>+</i></summary>
            <div className="detail-content detail-grid">
              <div><span>Minimum meaningful lift</span><strong>2.0pp</strong><p>Defined against a 59.8% control attempt rate.</p></div>
              <div><span>Required sample</span><strong>9,351 / arm</strong><p>At 80% power and α = 0.05.</p></div>
              <div><span>Actual MDE</span><strong>1.08pp</strong><p>The observed +3.1pp lift was well above the experiment’s detection floor.</p></div>
            </div>
          </details>
          <details>
            <summary><span>03</span><strong>Statistical method</strong><small>Tests, intervals, and robustness</small><i>+</i></summary>
            <div className="detail-content prose-detail">
              <p>Two-proportion z-tests compared control and treatment rates, with 95% Wald confidence intervals. The primary result remains significant under a conservative multiple-comparison correction. CUPED was identified as a production follow-up, not retroactively applied.</p>
            </div>
          </details>
          <details>
            <summary><span>04</span><strong>Limits of the evidence</strong><small>What this experiment cannot establish</small><i>+</i></summary>
            <div className="detail-content prose-detail">
              <p>The dataset is aggregated at user level, retention covers one short window, and the test measures engagement rather than learning outcomes. The data is consistent with harder personalized quizzes causing abandonment, but it does not prove that mechanism.</p>
            </div>
          </details>
        </div>
      </section>

      <section className="github-cta">
        <span className="section-number">NOTEBOOK / METHODOLOGY</span>
        <h2>Read the full<br /><em>notebook methodology.</em></h2>
        <p>The notebook covers cleaning, balance checks, power, hypothesis tests, confidence intervals, segment analysis, and limitations.</p>
        <a href="https://github.com/AinSid/AI-quiz-ab-test" target="_blank" rel="noreferrer">
          Open the analysis on GitHub <ArrowIcon />
        </a>
      </section>

<footer className="site-footer">
  <div><span>Personalized AI Quizzes</span><small>Ain Siddiqui</small></div>
        <div className="footer-stack"><span>Python · pandas · statsmodels · SciPy</span><span>React · TypeScript · Canvas</span></div>
        <a href="#top">Back to top ↑</a>
      </footer>

      <a className="floating-github" href="https://github.com/AinSid/AI-quiz-ab-test" target="_blank" rel="noreferrer">
        View GitHub repo <ArrowIcon />
      </a>

      {aboutOpen && (
        <div className="about-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setAboutOpen(false);
        }}>
          <section className="about-modal explore-modal" role="dialog" aria-modal="true" aria-labelledby="about-title">
            <div className="about-modal-topline"><span>EXPLORE THE STUDY</span><button type="button" autoFocus onClick={() => setAboutOpen(false)} aria-label="Close experiment details">×</button></div>
            <h2 id="about-title">Do personalized AI quizzes make students more likely to start a quiz?</h2>
            <p>That is the product question behind this project. In the experiment, 64,888 students were randomly split between the standard quiz and a personalized AI quiz.</p>
            <p>The analysis compares quiz starts, completions, seven-day retention, and the difference between new and old users. The data is simulated to mirror a real education product experiment.</p>
            <p>The notebook contains the data checks, statistical tests, and rollout recommendation. This page turns those results into a short, visual case study.</p>
            <button className="about-close" type="button" onClick={() => setAboutOpen(false)}>Back to the experiment</button>
          </section>
        </div>
      )}

      {profileOpen && (
        <div className="about-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setProfileOpen(false);
        }}>
          <section className="about-modal personal-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title">
            <div className="about-modal-topline"><span id="profile-title">ABOUT ME</span><button type="button" autoFocus onClick={() => setProfileOpen(false)} aria-label="Close About Me">×</button></div>
            <p>Hi, I’m Ain Siddiqui. I’m a Technical Product Manager for Data Platforms at Wood Mackenzie and a master’s student in Data Science at Columbia University. I previously studied Mathematics and Computer Science at UCLA.</p>
            <p>My work focuses on data products, experimentation, and infrastructure. I enjoy breaking down complex problems and turning them into practical tools and clear decisions.</p>
            <p>Outside work and school, I build personal projects like this one, explore new restaurants, and play soccer.</p>
            <nav className="personal-links" aria-label="Ain Siddiqui links">
              <a href="https://ain-siddiqui.com/" target="_blank" rel="noreferrer">Website</a>
              <a href="https://www.linkedin.com/in/ain1/" target="_blank" rel="noreferrer">LinkedIn</a>
              <a className="x-profile-link" href="https://x.com/ain__siddiqui" target="_blank" rel="noreferrer" aria-label="X, formerly Twitter">
                <span className="desktop-link-label">X / Twitter</span>
                <span className="mobile-link-label">X</span>
              </a>
              <a href="https://github.com/AinSid" target="_blank" rel="noreferrer">GitHub</a>
              <a href="mailto:ain.sidd2@gmail.com">Email</a>
            </nav>
          </section>
        </div>
      )}
    </main>
  );
}
