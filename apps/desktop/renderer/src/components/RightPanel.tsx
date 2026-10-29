import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderSearch,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  Ruler,
  Search,
} from "lucide-react";
import {
  type DisplaySet,
  type SortDirection,
  type SortKey,
  type TagNode,
  formatDicomDate,
  formatNumber,
  formatPersonName,
  planeKind,
  spacingBasis,
} from "@clinic/dicom-core";
import { useStore } from "../state/store";
import { controllerAt } from "../viewer/registry";
import { fileIdOf } from "../viewer/cornerstone";
import { IconButton } from "./ui";

const TS_NAMES: Record<string, string> = {
  "1.2.840.10008.1.2": "Implicit VR Little Endian",
  "1.2.840.10008.1.2.1": "Explicit VR Little Endian",
  "1.2.840.10008.1.2.1.99": "Deflated Explicit VR Little Endian",
  "1.2.840.10008.1.2.2": "Explicit VR Big Endian",
  "1.2.840.10008.1.2.4.50": "JPEG Baseline (8-bit)",
  "1.2.840.10008.1.2.4.51": "JPEG Extended (12-bit)",
  "1.2.840.10008.1.2.4.57": "JPEG Lossless (Process 14)",
  "1.2.840.10008.1.2.4.70": "JPEG Lossless SV1",
  "1.2.840.10008.1.2.4.80": "JPEG-LS Lossless",
  "1.2.840.10008.1.2.4.81": "JPEG-LS Near-lossless",
  "1.2.840.10008.1.2.4.90": "JPEG 2000 Lossless",
  "1.2.840.10008.1.2.4.91": "JPEG 2000",
  "1.2.840.10008.1.2.4.201": "HTJ2K Lossless",
  "1.2.840.10008.1.2.4.202": "HTJ2K Lossless RPCL",
  "1.2.840.10008.1.2.4.203": "HTJ2K",
  "1.2.840.10008.1.2.5": "RLE Lossless",
};

function useActiveDisplaySet(): DisplaySet | undefined {
  return useStore((s) => {
    const id = s.slots[s.activeIndex];
    return id ? s.displaySets[id] : undefined;
  });
}

/** Current image id of the active viewport (re-evaluated on image change). */
function useActiveImageId(): string | undefined {
  const activeIndex = useStore((s) => s.activeIndex);
  const ds = useActiveDisplaySet();
  const [imageId, setImageId] = useState<string | undefined>();
  const c = controllerAt(activeIndex);
  useEffect(
    () =>
      c?.subscribe((vs) =>
        setImageId(vs.status === "ready" ? vs.imageId : undefined),
      ),
    [c, ds],
  );
  return c ? imageId : undefined;
}

function InfoPanel(): ReactNode {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language === "en" ? "en" : "tr") as "tr" | "en";
  const ds = useActiveDisplaySet();
  const hide = useStore((s) => s.settings.hidePatientData);
  const sortKey = useStore((s) => s.sortKey);
  const sortDirection = useStore((s) => s.sortDirection);
  if (!ds)
    return <div className="panel-pad muted">{t("info.noSelection")}</div>;
  const i = ds.firstInstance;
  const basis = spacingBasis(i);
  const plane = planeKind(i);
  const mm = (v: number | undefined, d = 3): string =>
    v === undefined ? "—" : `${formatNumber(v, d, locale)} mm`;
  const ps = i.geometry.pixelSpacing ?? ds.images[0]?.geometry.pixelSpacing;
  return (
    <div className="panel-pad" data-testid="info-panel">
      <dl className="kv">
        <dt>{t("info.patient")}</dt>
        <dd>
          {hide
            ? t("viewport.hidden")
            : `${formatPersonName(i.patientName, locale)} (${i.patientId ?? "—"})`}
        </dd>
        <dt>{t("info.study")}</dt>
        <dd>
          {[formatDicomDate(i.studyDate, locale), i.studyDescription]
            .filter(Boolean)
            .join(" · ") || "—"}
        </dd>
        <dt>{t("info.series")}</dt>
        <dd>
          {[i.seriesNumber, i.seriesDescription]
            .filter((v) => v !== undefined && v !== "")
            .join(" · ") || "—"}
        </dd>
        <dt>{t("info.modality")}</dt>
        <dd>{i.modality ?? "—"}</dd>
        <dt>{t("info.images")}</dt>
        <dd className="num">{ds.images.length}</dd>
        <dt>{t("info.matrix")}</dt>
        <dd className="num">
          {i.columns && i.rows ? `${i.columns} × ${i.rows}` : "—"}
        </dd>
        <dt>{t("info.pixelSpacing")}</dt>
        <dd className="num">
          {ps
            ? `${formatNumber(ps[0], 4, locale)} × ${formatNumber(ps[1], 4, locale)} mm`
            : "—"}
        </dd>
        <dt>{t("info.spacingBasis")}</dt>
        <dd data-testid="info-basis">
          {t(`basis.${basis.kind}`, {
            mag: basis.kind === "imagerMagnified" ? basis.magnification : "",
          })}
        </dd>
        <dt>{t("info.sliceSpacing")}</dt>
        <dd className="num">{mm(ds.geometry.sliceSpacing)}</dd>
        <dt>{t("info.sliceThickness")}</dt>
        <dd className="num">
          {mm(
            i.geometry.sliceThickness ?? ds.images[0]?.geometry.sliceThickness,
          )}
        </dd>
        {ds.geometry.tiltDeg !== undefined && ds.geometry.tiltDeg > 0.01 ? (
          <>
            <dt>{t("info.tilt")}</dt>
            <dd className="num">{`${formatNumber(ds.geometry.tiltDeg, 2, locale)}°`}</dd>
          </>
        ) : null}
        <dt>{t("info.orientation")}</dt>
        <dd>{t(`planes.${plane}`)}</dd>
        <dt>{t("info.sortedBy")}</dt>
        <dd data-testid="info-sorted">
          {ds.geometry.sortFallback
            ? t("info.sortFallback")
            : t(`sort.${ds.geometry.sortedBy}`)}
        </dd>
        <dt>{t("info.transferSyntax")}</dt>
        <dd>{TS_NAMES[i.transferSyntaxUid] ?? i.transferSyntaxUid}</dd>
        <dt>{t("info.photometric")}</dt>
        <dd>{i.photometricInterpretation ?? "—"}</dd>
        <dt>{t("info.bits")}</dt>
        <dd className="num">
          {i.bitsAllocated
            ? `${i.bitsAllocated} / ${i.bitsStored ?? "—"}${i.pixelRepresentation ? ` (${t("info.signed")})` : ""}`
            : "—"}
        </dd>
        <dt>{t("info.charset")}</dt>
        <dd>
          {i.specificCharacterSet ?? "ISO_IR 6"}
          {i.charsetUncertain ? ` — ${t("info.charsetUncertain")}` : ""}
        </dd>
        {i.overlayGroups?.length ? (
          <>
            <dt>{t("info.overlays")}</dt>
            <dd>
              {i.overlayGroups
                .map((g) => g.toString(16).toUpperCase())
                .join(", ")}
            </dd>
          </>
        ) : null}
        {i.hasModalityLutSequence || i.hasVoiLutSequence ? (
          <>
            <dt>{t("info.lutSequences")}</dt>
            <dd>
              {[
                i.hasModalityLutSequence ? t("info.modalityLut") : "",
                i.hasVoiLutSequence ? t("info.voiLut") : "",
              ]
                .filter(Boolean)
                .join(", ")}
            </dd>
          </>
        ) : null}
      </dl>

      <div className="section-title">{t("info.sort")}</div>
      <div className="row2">
        <select
          className="select"
          value={sortKey}
          aria-label={t("info.sort")}
          data-testid="sort-key"
          onChange={(e) =>
            useStore
              .getState()
              .setSort(e.target.value as SortKey, sortDirection)
          }
        >
          {(
            [
              "spatial",
              "instanceNumber",
              "acquisitionTime",
              "fileName",
            ] as const
          ).map((k) => (
            <option key={k} value={k}>
              {t(`sort.${k}`)}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={sortDirection}
          aria-label={t("info.direction")}
          data-testid="sort-direction"
          onChange={(e) =>
            useStore
              .getState()
              .setSort(sortKey, e.target.value as SortDirection)
          }
        >
          <option value="asc">{t("sort.asc")}</option>
          <option value="desc">{t("sort.desc")}</option>
        </select>
      </div>

      <div className="section-title">{t("info.warnings")}</div>
      {ds.warnings.length === 0 ? (
        <div className="muted">{t("info.noWarnings")}</div>
      ) : (
        <div className="warning-list" data-testid="info-warnings">
          {ds.warnings.map((w, k) => (
            <div className="warning-item" key={k}>
              <AlertTriangle size={14} />
              <span>{t(`warnings.${w.code}`, { value: w.value })}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function flatten(
  nodes: TagNode[],
  depth = 0,
  out: { node: TagNode; depth: number; path: string }[] = [],
  prefix = "",
): typeof out {
  nodes.forEach((n) => {
    const path = `${prefix}${n.tag}`;
    out.push({ node: n, depth, path });
    n.items?.forEach((item, i) => {
      out.push({
        node: { tag: "", name: `#${i + 1}`, vr: "", length: 0, value: "" },
        depth: depth + 1,
        path: `${path}/${i}`,
      });
      flatten(item, depth + 2, out, `${path}/${i}/`);
    });
  });
  return out;
}

function TagBrowser(): ReactNode {
  const { t } = useTranslation();
  const imageId = useActiveImageId();
  const fileId = imageId ? fileIdOf(imageId) : undefined;
  if (!fileId)
    return <div className="panel-pad muted">{t("tags.noImage")}</div>;
  // Keyed by file so search/collapse/location state resets when the image changes.
  return <TagList key={fileId} fileId={fileId} />;
}

/** Tags masked when "hide patient data" is on (patient identity and identifying study attributes). */
const IDENTIFYING_TAGS = new Set([
  "(0010,0010)",
  "(0010,0020)",
  "(0010,0030)",
  "(0010,0032)",
  "(0010,1000)",
  "(0010,1001)",
  "(0010,1040)",
  "(0010,2154)",
  "(0008,0050)",
  "(0008,0080)",
  "(0008,0081)",
  "(0008,0090)",
  "(0008,1048)",
  "(0008,1050)",
  "(0008,1070)",
  "(0020,0010)",
  "(0010,21B0)",
  "(0010,4000)",
]);

function maskTags(nodes: TagNode[], hidden: string): TagNode[] {
  return nodes.map((n) => ({
    ...n,
    value: IDENTIFYING_TAGS.has(n.tag) ? hidden : n.value,
    ...(n.items ? { items: n.items.map((it) => maskTags(it, hidden)) } : {}),
  }));
}

function TagList(props: { fileId: string }): ReactNode {
  const { t } = useTranslation();
  const { fileId } = props;
  const pinned = useStore((s) => s.pinnedTags);
  const hide = useStore((s) => s.settings.hidePatientData);
  const [nodes, setNodes] = useState<TagNode[] | null>(null);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [location, setLocation] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api
      .readTags(fileId)
      .then((n) => {
        if (!cancelled) setNodes(n);
      })
      .catch(() => {
        if (!cancelled) setNodes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  const rows = useMemo(() => {
    if (!nodes) return [];
    const flat = flatten(hide ? maskTags(nodes, t("viewport.hidden")) : nodes);
    const q = query.trim().toLocaleLowerCase();
    const visible = flat.filter((r) => {
      // Hide rows below a collapsed sequence.
      for (const c of collapsed)
        if (r.path !== c && r.path.startsWith(`${c}/`)) return false;
      return true;
    });
    const matching = q
      ? flat.filter(
          (r) =>
            r.node.tag &&
            `${r.node.tag} ${r.node.name} ${r.node.value}`
              .toLocaleLowerCase()
              .includes(q),
        )
      : visible;
    const pins = flat.filter(
      (r) => r.node.tag && pinned.includes(r.node.tag) && r.depth === 0,
    );
    return [
      ...pins.map((r) => ({ ...r, pinnedCopy: true })),
      ...matching.map((r) => ({ ...r, pinnedCopy: false })),
    ];
  }, [nodes, query, collapsed, pinned, hide, t]);

  const copy = async (text: string, key: string): Promise<void> => {
    try {
      await window.api.copyText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      useStore.getState().notify("warning", t("tags.copyFailed"));
    }
  };

  const allText = (): string =>
    flatten(hide ? maskTags(nodes ?? [], t("viewport.hidden")) : (nodes ?? []))
      .filter((r) => r.node.tag)
      .map(
        (r) =>
          `${"  ".repeat(r.depth)}${r.node.tag} ${r.node.vr} ${r.node.name}: ${r.node.value}`,
      )
      .join("\n");

  return (
    <div data-testid="tag-browser">
      <label className="search">
        <Search size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("tags.search")}
          aria-label={t("tags.search")}
          data-testid="tag-search"
        />
      </label>
      <div className="tag-actions">
        <button
          type="button"
          className="small-btn"
          onClick={() => void copy(allText(), "all")}
          data-testid="tag-copy-all"
        >
          <Copy size={12} />{" "}
          {copied === "all" ? t("tags.copied") : t("tags.copyAll")}
        </button>
        <button
          type="button"
          className="small-btn"
          onClick={() => void window.api.fileLocation(fileId).then(setLocation)}
          data-testid="tag-location"
        >
          <FolderSearch size={12} /> {t("tags.showLocation")}
        </button>
      </div>
      {location ? (
        <div className="location" data-testid="tag-location-text">
          {location}{" "}
          <button
            type="button"
            className="link-btn"
            onClick={() => void window.api.revealFile(fileId)}
          >
            {t("tags.reveal")}
          </button>
        </div>
      ) : null}
      {!nodes ? (
        <div className="panel-pad muted">{t("tags.loading")}</div>
      ) : null}
      {nodes && rows.length === 0 ? (
        <div className="panel-pad muted">{t("tags.noMatch")}</div>
      ) : null}
      <div className="tag-table" role="table">
        {rows.map((r, k) => {
          if (!r.node.tag) {
            return (
              <div
                key={`${r.path}-${k}`}
                className="tag-row"
                style={{ ["--depth" as string]: r.depth }}
              >
                <span />
                <span className="muted">
                  {t("tags.item", { n: r.node.name.slice(1) })}
                </span>
                <span />
                <span />
              </div>
            );
          }
          const isSeq = Boolean(r.node.items);
          const isCollapsed = collapsed.has(r.path);
          const isPinned = pinned.includes(r.node.tag);
          return (
            <div
              key={`${r.pinnedCopy ? "p" : ""}${r.path}-${k}`}
              className={`tag-row${r.pinnedCopy ? " pinned" : ""}`}
              style={{ ["--depth" as string]: r.depth }}
              role="row"
              data-testid="tag-row"
              data-tag={r.node.tag}
            >
              {isSeq ? (
                <button
                  type="button"
                  className="mini"
                  aria-label={r.node.name}
                  onClick={() => {
                    const next = new Set(collapsed);
                    if (isCollapsed) next.delete(r.path);
                    else next.add(r.path);
                    setCollapsed(next);
                  }}
                >
                  {isCollapsed ? (
                    <ChevronRight size={14} />
                  ) : (
                    <ChevronDown size={14} />
                  )}
                </button>
              ) : (
                <span />
              )}
              <span className="tagid">{r.node.tag}</span>
              <span className="tag-main">
                <span className="tag-head">
                  <span className="name" title={r.node.name}>
                    {r.node.name}
                  </span>
                  <span className="vr">{r.node.vr}</span>
                </span>
                <div
                  className="value"
                  onDoubleClick={() => void copy(r.node.value, r.path)}
                >
                  {copied === r.path ? t("tags.copied") : r.node.value}
                </div>
              </span>
              {r.depth === 0 ? (
                <button
                  type="button"
                  className={`mini${isPinned ? " on" : ""}`}
                  aria-label={isPinned ? t("tags.unpin") : t("tags.pin")}
                  title={isPinned ? t("tags.unpin") : t("tags.pin")}
                  onClick={() => useStore.getState().togglePin(r.node.tag)}
                >
                  <Pin size={12} />
                </button>
              ) : (
                <button
                  type="button"
                  className="mini"
                  aria-label={t("tags.copyValue")}
                  title={t("tags.copyValue")}
                  onClick={() => void copy(r.node.value, r.path)}
                >
                  <Copy size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function RightPanel(): ReactNode {
  const { t } = useTranslation();
  const open = useStore((s) => s.rightOpen);
  const tab = useStore((s) => s.rightTab);
  if (!open) {
    return (
      <aside className="side right collapsed" data-testid="right-panel">
        <div className="side-header">
          <IconButton
            tip={t("panel.expand")}
            tipPos="left"
            onClick={() => useStore.getState().toggleRight()}
          >
            <PanelRightOpen size={16} />
          </IconButton>
        </div>
      </aside>
    );
  }
  return (
    <aside className="side right right-panel" data-testid="right-panel">
      <div className="tabs" role="tablist">
        {(["measurements", "tags", "info"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className="tab"
            role="tab"
            aria-selected={tab === k}
            onClick={() => useStore.getState().setRightTab(k)}
            data-testid={`tab-${k}`}
          >
            {t(`panel.${k}`)}
          </button>
        ))}
        <IconButton
          tip={t("panel.collapse")}
          tipPos="left"
          onClick={() => useStore.getState().toggleRight()}
        >
          <PanelRightClose size={16} />
        </IconButton>
      </div>
      <div className="side-body">
        {tab === "info" ? <InfoPanel /> : null}
        {tab === "tags" ? <TagBrowser /> : null}
        {tab === "measurements" ? (
          <div
            className="panel-pad"
            style={{ textAlign: "center", paddingTop: 32 }}
          >
            <Ruler size={28} className="muted" />
            <div style={{ fontWeight: 600, marginTop: 8 }}>
              {t("measurements.empty")}
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              {t("measurements.emptyDetail")}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
