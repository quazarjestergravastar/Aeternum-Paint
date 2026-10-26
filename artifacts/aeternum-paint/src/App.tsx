import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import {
  ArrowLeft, Brush, Check, CircleHelp, Eraser, Eye, EyeOff, FileImage,
  Hand, Layers3, MoreHorizontal, Plus, Redo2, Search, Undo2, X, Download,
  PenLine, Copy, Trash2,
} from 'lucide-react';

type Layer = { id: string; name: string; visible: boolean; image?: string };
type Artwork = { id: string; title: string; width: number; height: number; created: number; updated: number; layers: Layer[]; preview?: string };
type Tool = 'brush' | 'smudge' | 'eraser';
type Preset = { name: string; color: string; width: number; height: number; detail: string };

const queryClient = new QueryClient();
const DB_NAME = 'aeternum-paint-studio';
const STORE = 'artworks';
const presets: Preset[] = [
  { name: 'Screen Size', color: 'P3', width: 1206, height: 2622, detail: '1206 × 2622 px' },
  { name: 'Untitled Canvas', color: 'P3', width: 1500, height: 500, detail: '1500 × 500 px' },
  { name: 'Untitled Canvas', color: 'P3', width: 16, height: 16, detail: '16 × 16 px' },
  { name: 'Untitled Canvas', color: 'P3', width: 2000, height: 2500, detail: '2000 × 2500 px' },
  { name: 'Square', color: 'sRGB', width: 2048, height: 2048, detail: '2048 × 2048 px' },
  { name: '4K', color: 'sRGB', width: 4096, height: 1714, detail: '4096 × 1714 px' },
  { name: 'A4', color: 'sRGB', width: 2480, height: 3508, detail: '210 × 297 mm' },
  { name: '4 × 6 Photo', color: 'sRGB', width: 1800, height: 1200, detail: '6″ × 4″' },
  { name: 'Paper', color: 'sRGB', width: 2550, height: 3300, detail: '11″ × 8.5″' },
];

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readArtworks(): Promise<Artwork[]> {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve((request.result as Artwork[]).sort((a, b) => b.updated - a.updated));
      request.onerror = () => reject(request.error);
    });
  } catch { return []; }
}
async function writeArtwork(artwork: Artwork) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(artwork);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
async function removeArtwork(id: string) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const makeLayer = (index: number): Layer => ({ id: makeId(), name: `Layer ${index}`, visible: true });

function AppHome() {
  const [artworks, setArtworks] = useState<Artwork[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [screen, setScreen] = useState<'gallery' | 'editor'>('gallery');
  const [project, setProject] = useState<Artwork | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selectedArtworkIds, setSelectedArtworkIds] = useState<string[]>([]);
  const [customWidth, setCustomWidth] = useState('2048');
  const [customHeight, setCustomHeight] = useState('2048');
  const [selectedPreset, setSelectedPreset] = useState(-1);
  const [activeLayerId, setActiveLayerId] = useState('');
  const [tool, setTool] = useState<Tool>('brush');
  const [brushSize, setBrushSize] = useState(18);
  const [opacity, setOpacity] = useState(88);
  const [color, setColor] = useState('#3b3935');
  const [colorOpen, setColorOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [layerMenu, setLayerMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const [paperSize, setPaperSize] = useState({ width: 800, height: 600 });
  const [historyVersion, setHistoryVersion] = useState(0);
  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const paperRef = useRef<HTMLDivElement>(null);
  const drawing = useRef(false);
  const points = useRef<{ x: number; y: number; pressure: number }[]>([]);
  const history = useRef<Record<string, { undo: string[]; redo: string[] }>>({});
  const saveTimer = useRef<number | undefined>(undefined);
  const activeLayer = project?.layers.find(layer => layer.id === activeLayerId) ?? project?.layers[0];

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try { setArtworks(await readArtworks()); } catch { setLoadFailed(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!project || screen !== 'editor') return;
    const element = paperRef.current?.parentElement;
    if (!element) return;
    const measure = () => {
      const padding = window.getComputedStyle(element);
      const maxWidth = Math.max(180, element.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight));
      const maxHeight = Math.max(180, element.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom));
      const scale = Math.min(maxWidth / project.width, maxHeight / project.height);
      setPaperSize({ width: Math.round(project.width * scale), height: Math.round(project.height * scale) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [project?.id, project?.width, project?.height, screen]);

  useEffect(() => {
    if (!project || screen !== 'editor') return;
    for (const layer of project.layers) {
      const canvas = canvasRefs.current[layer.id];
      if (!canvas) continue;
      canvas.width = project.width;
      canvas.height = project.height;
      if (layer.image) {
        const image = new Image();
        image.onload = () => {
          const context = canvas.getContext('2d');
          context?.clearRect(0, 0, canvas.width, canvas.height);
          context?.drawImage(image, 0, 0, canvas.width, canvas.height);
        };
        image.src = layer.image;
      }
    }
  }, [project?.id, screen]);

  const persist = useCallback((current: Artwork, previewOverride?: string) => {
    setSaving(true);
    const layers = current.layers.map(layer => {
      const canvas = canvasRefs.current[layer.id];
      return canvas ? { ...layer, image: canvas.toDataURL('image/png') } : layer;
    });
    const preview = previewOverride ?? compositePreview(current, layers, canvasRefs.current);
    const next = { ...current, layers, preview, updated: Date.now() };
    setProject(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void writeArtwork(next).then(() => {
        setArtworks(existing => [next, ...existing.filter(item => item.id !== next.id)].sort((a, b) => b.updated - a.updated));
        setSaving(false);
      }).catch(() => setSaving(false));
    }, 150);
  }, []);

  const createArtwork = useCallback((title: string, width: number, height: number) => {
    const next: Artwork = { id: makeId(), title, width, height, created: Date.now(), updated: Date.now(), layers: [makeLayer(1)] };
    setProject(next);
    setActiveLayerId(next.layers[0].id);
    history.current = {};
    void writeArtwork(next).then(() => setArtworks(items => [next, ...items]));
    setScreen('editor');
    setSheetOpen(false);
  }, []);

  const openArtwork = (artwork: Artwork) => {
    setProject(artwork);
    setActiveLayerId(artwork.layers.find(layer => layer.visible)?.id ?? artwork.layers[0]?.id ?? '');
    history.current = {};
    setScreen('editor');
  };

  const commitStroke = useCallback(() => {
    if (!project || !activeLayer) return;
    const canvas = canvasRefs.current[activeLayer.id];
    if (!canvas) return;
    const stack = history.current[activeLayer.id] ?? { undo: [], redo: [] };
    stack.redo = [];
    history.current[activeLayer.id] = stack;
    setHistoryVersion(value => value + 1);
    persist(project);
  }, [project, activeLayer, persist]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (event.currentTarget.width / rect.width),
      y: (event.clientY - rect.top) * (event.currentTarget.height / rect.height),
      pressure: event.pressure || 0.5,
    };
  };
  const drawSegment = (context: CanvasRenderingContext2D, from: { x: number; y: number; pressure: number }, to: { x: number; y: number; pressure: number }) => {
    if (tool === 'smudge') {
      const radius = Math.max(3, brushSize * (0.45 + to.pressure * 0.9));
      const offsetX = (to.x - from.x) * 0.75;
      const offsetY = (to.y - from.y) * 0.75;
      context.save();
      context.globalAlpha = opacity / 100 * 0.62;
      context.filter = `blur(${Math.max(0.5, brushSize * 0.08)}px)`;
      context.drawImage(
        context.canvas,
        from.x - radius,
        from.y - radius,
        radius * 2,
        radius * 2,
        from.x - radius + offsetX,
        from.y - radius + offsetY,
        radius * 2,
        radius * 2,
      );
      context.restore();
      return;
    }
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.globalAlpha = tool === 'eraser' ? 1 : opacity / 100;
    context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    context.strokeStyle = tool === 'eraser' ? 'rgba(0,0,0,1)' : color;
    context.lineWidth = Math.max(1, brushSize * (0.45 + to.pressure * 0.9));
    context.beginPath();
    context.moveTo(from.x, from.y);
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    context.quadraticCurveTo(from.x, from.y, midX, midY);
    context.stroke();
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!activeLayer) return;
    const canvas = event.currentTarget;
    canvas.setPointerCapture(event.pointerId);
    drawing.current = true;
    const point = pointFromEvent(event);
    const stack = history.current[activeLayer.id] ?? { undo: [], redo: [] };
    stack.undo.push(canvas.toDataURL('image/png'));
    if (stack.undo.length > 40) stack.undo.shift();
    stack.redo = [];
    history.current[activeLayer.id] = stack;
    setHistoryVersion(value => value + 1);
    points.current = [point];
    const context = canvas.getContext('2d');
    if (context && tool !== 'smudge') {
      context.fillStyle = tool === 'eraser' ? 'rgba(0,0,0,1)' : color;
      context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
      context.globalAlpha = tool === 'eraser' ? 1 : opacity / 100;
      context.beginPath();
      context.arc(point.x, point.y, Math.max(1, brushSize * (0.45 + point.pressure * 0.9) / 2), 0, Math.PI * 2);
      context.fill();
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = 1;
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    for (const nativeEvent of coalesced) {
      const rect = event.currentTarget.getBoundingClientRect();
      const next = {
        x: (nativeEvent.clientX - rect.left) * (event.currentTarget.width / rect.width),
        y: (nativeEvent.clientY - rect.top) * (event.currentTarget.height / rect.height),
        pressure: nativeEvent.pressure || 0.5,
      };
      const previous = points.current[points.current.length - 1];
      if (previous) drawSegment(context, previous, next);
      points.current.push(next);
    }
  };
  const onPointerUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    commitStroke();
  };
  const undo = () => {
    if (!activeLayer) return;
    const canvas = canvasRefs.current[activeLayer.id];
    const stack = history.current[activeLayer.id];
    if (!canvas || !stack?.undo.length) return;
    stack.redo.push(canvas.toDataURL('image/png'));
    const image = new Image();
    image.onload = () => {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      ctx?.drawImage(image, 0, 0);
      if (project) persist(project);
      setHistoryVersion(v => v + 1);
    };
    image.src = stack.undo.pop()!;
  };
  const redo = () => {
    if (!activeLayer) return;
    const canvas = canvasRefs.current[activeLayer.id];
    const stack = history.current[activeLayer.id];
    if (!canvas || !stack?.redo.length) return;
    stack.undo.push(canvas.toDataURL('image/png'));
    const image = new Image();
    image.onload = () => {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      ctx?.drawImage(image, 0, 0);
      if (project) persist(project);
      setHistoryVersion(v => v + 1);
    };
    image.src = stack.redo.pop()!;
  };

  const setLayerVisibility = (id: string) => {
    if (!project) return;
    const layers = project.layers.map(layer => layer.id === id ? { ...layer, visible: !layer.visible } : layer);
    const updated = { ...project, layers };
    setProject(updated);
    if (id === activeLayerId && !layers.find(layer => layer.id === id)?.visible) {
      const replacement = layers.find(layer => layer.visible);
      if (replacement) setActiveLayerId(replacement.id);
    }
    persist(updated);
  };
  const addLayer = () => {
    if (!project) return;
    const layer = makeLayer(project.layers.length + 1);
    const next = { ...project, layers: [...project.layers, layer] };
    canvasRefs.current[layer.id] = null;
    setProject(next);
    setActiveLayerId(layer.id);
    setTimeout(() => {
      const canvas = canvasRefs.current[layer.id];
      if (canvas) { canvas.width = project.width; canvas.height = project.height; }
    }, 0);
  };
  const renameLayer = (id: string, name: string) => {
    if (!project || !name.trim()) return;
    const next = { ...project, layers: project.layers.map(layer => layer.id === id ? { ...layer, name: name.trim() } : layer) };
    setProject(next);
    persist(next);
  };
  const deleteLayer = (id: string) => {
    if (!project || project.layers.length < 2) return;
    const nextLayers = project.layers.filter(layer => layer.id !== id);
    const next = { ...project, layers: nextLayers };
    setProject(next);
    setActiveLayerId(nextLayers[nextLayers.length - 1].id);
    delete canvasRefs.current[id];
    persist(next);
  };
  const exportPng = () => {
    if (!project) return;
    const output = document.createElement('canvas');
    output.width = project.width;
    output.height = project.height;
    const ctx = output.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#fffefa';
    ctx.fillRect(0, 0, output.width, output.height);
    project.layers.forEach(layer => {
      if (layer.visible && canvasRefs.current[layer.id]) ctx.drawImage(canvasRefs.current[layer.id]!, 0, 0);
    });
    const link = document.createElement('a');
    link.download = `${project.title.trim().replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'aeternum-artwork'}.png`;
    link.href = output.toDataURL('image/png');
    link.click();
  };
  const returnToGallery = () => {
    if (project) persist(project);
    setLayersOpen(false);
    setColorOpen(false);
    setScreen('gallery');
    setProject(null);
    void refresh();
  };
  const toggleArtworkSelection = (id: string) => {
    setSelectedArtworkIds(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  };
  const deleteSelectedArtworks = async () => {
    const ids = [...selectedArtworkIds];
    await Promise.all(ids.map(id => removeArtwork(id).catch(() => undefined)));
    setArtworks(items => items.filter(item => !ids.includes(item.id)));
    setSelectedArtworkIds([]);
    setSelecting(false);
  };
  const renameProject = (title: string) => {
    if (!project) return;
    const next = { ...project, title };
    setProject(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void writeArtwork(next).then(() => setArtworks(items => items.map(item => item.id === next.id ? next : item))), 250);
  };
  const filtered = useMemo(() => artworks.filter(item => item.title.toLowerCase().includes(search.toLowerCase())), [artworks, search]);
  const hasUndo = !!(activeLayer && history.current[activeLayer.id]?.undo.length);
  const hasRedo = !!(activeLayer && history.current[activeLayer.id]?.redo.length);
  void historyVersion;

  if (screen === 'editor' && project) {
    return (
      <main className="editor" aria-label="Aeternum Paint editor">
        <div className="editor-top">
          <button className="editor-back" onClick={returnToGallery} aria-label="Return to gallery" data-testid="button-gallery"><ArrowLeft size={17} /><span>Gallery</span></button>
          <input className="document-name" aria-label="Artwork title" value={project.title} onChange={event => renameProject(event.target.value)} data-testid="input-artwork-title" />
        </div>
        <div className="float-toolbar" role="toolbar" aria-label="Drawing tools">
          <div className="tool-main-row">
            <button className={`tool-button ${tool === 'brush' ? 'active' : ''}`} title="Brush" aria-label="Brush tool" onClick={() => setTool('brush')} data-testid="tool-brush"><Brush size={19} /></button>
            <button className={`tool-button ${tool === 'smudge' ? 'active' : ''}`} title="Smudge" aria-label="Smudge tool" onClick={() => setTool('smudge')} data-testid="tool-smudge"><Hand size={18} /></button>
            <button className={`tool-button ${tool === 'eraser' ? 'active' : ''}`} title="Eraser" aria-label="Eraser tool" onClick={() => setTool('eraser')} data-testid="tool-eraser"><Eraser size={19} /></button>
          <button className="tool-button" title="Layers" aria-label="Open layers" onClick={() => setLayersOpen(true)} data-testid="tool-open-layers"><Layers3 size={18} /></button>
            <button className="tool-button color-tool" title="Choose color" aria-label="Open color picker" style={{ backgroundColor: color }} onClick={() => setColorOpen(true)} data-testid="button-color" />
          </div>
          <div className="tool-sub-row">
            <div className="undo-group">
              <button className="tool-button" aria-label="Undo" title="Undo" onClick={undo} disabled={!hasUndo} data-testid="button-undo"><Undo2 size={18} /></button>
              <button className="tool-button" aria-label="Redo" title="Redo" onClick={redo} disabled={!hasRedo} data-testid="button-redo"><Redo2 size={18} /></button>
            </div>
            <button className="tool-button" aria-label="Layers" title="Layers" onClick={() => setLayersOpen(true)} data-testid="button-layers"><Layers3 size={18} /></button>
            <button className="tool-button" aria-label="Export artwork as PNG" title="Export PNG" onClick={exportPng} data-testid="tool-export"><Download size={17} /></button>
          </div>
        </div>
        <div className="floating-actions">
          <button className="round-control" onClick={exportPng} aria-label="Export artwork as PNG" title="Export PNG" data-testid="button-export"><Download size={18} /></button>
          <button className="round-control" onClick={() => setLayersOpen(true)} aria-label="Manage layers" title="Layers" data-testid="button-open-layers"><Layers3 size={18} /></button>
        </div>
        <div className="editor-controls" aria-label="Brush settings">
          <div className="vertical-control" title={`Brush size ${brushSize}`}><input aria-label="Brush size" type="range" min="1" max="100" value={brushSize} onChange={event => setBrushSize(Number(event.target.value))} data-testid="slider-brush-size" /></div>
          <div className="vertical-control" title={`Opacity ${opacity}%`}><input aria-label="Brush opacity" type="range" min="5" max="100" value={opacity} onChange={event => setOpacity(Number(event.target.value))} data-testid="slider-opacity" /></div>
        </div>
        <div className="canvas-stage">
          <div className="paper" ref={paperRef} style={{ width: paperSize.width, height: paperSize.height }} data-testid="canvas-paper">
            {project.layers.map(layer => (
              <canvas key={layer.id} ref={element => { canvasRefs.current[layer.id] = element; }} width={project.width} height={project.height}
                style={{ display: layer.visible ? 'block' : 'none', pointerEvents: layer.id === activeLayer?.id ? 'auto' : 'none', zIndex: project.layers.indexOf(layer) }}
                onPointerDown={layer.id === activeLayer?.id ? onPointerDown : undefined}
                onPointerMove={layer.id === activeLayer?.id ? onPointerMove : undefined}
                onPointerUp={layer.id === activeLayer?.id ? onPointerUp : undefined}
                onPointerCancel={layer.id === activeLayer?.id ? onPointerUp : undefined}
                aria-label={`${layer.name} drawing surface`} data-testid={`canvas-layer-${layer.id}`} />
            ))}
          </div>
        </div>
        <div className="brush-label">{`${tool[0].toUpperCase()}${tool.slice(1)} · ${brushSize}px · ${opacity}%`}</div>
        <div className="bottom-status">{saving ? 'Saving to this device…' : `${project.width} × ${project.height} px · On this device`}</div>
        {layersOpen && <LayersSheet project={project} activeLayerId={activeLayer?.id ?? ''} onClose={() => setLayersOpen(false)} onAdd={addLayer} onActive={setActiveLayerId} onVisibility={setLayerVisibility} onRename={renameLayer} onDelete={deleteLayer} canvasRefs={canvasRefs.current} />}
        {colorOpen && <ColorPicker color={color} onChange={setColor} onClose={() => setColorOpen(false)} />}
      </main>
    );
  }

  return (
    <main className="studio-shell">
      <div className="studio-content">
        <section className="gallery-wrap">
          <header className="topline">
            <div className="brand"><div className="brand-mark"><PenLine size={17} /></div><span className="brand-name">Aeternum Paint</span></div>
            <div className="top-note">A small studio for the things you make</div>
          </header>
          <div className="gallery-heading">
            <div><h1>Aeternum Paint</h1><p className="gallery-subtitle">Your drawings, right here.</p></div>
            <div className="gallery-actions">
              <label className="search-box"><Search size={17} /><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a canvas" aria-label="Search artwork" data-testid="input-search-artwork" /></label>
              <button className="pill-button" onClick={() => setSheetOpen(true)} data-testid="button-new-canvas"><Plus size={18} />New canvas</button>
            </div>
          </div>
          <div className="gallery-meta"><span>{search ? `Results for “${search}”` : 'RECENT WORK'}</span><span>{artworks.length} {artworks.length === 1 ? 'canvas' : 'canvases'}</span></div>
          {loading ? (
            <div className="art-grid" aria-label="Loading artworks">{[0,1,2,3].map(item => <div key={item} className="art-thumb" style={{ background: 'linear-gradient(110deg,#e8e4dd 25%,#f4f0e8 38%,#e8e4dd 60%)', backgroundSize: '200% 100%' }} />)}</div>
          ) : loadFailed ? (
            <div className="empty-gallery"><CircleHelp size={30} /><h2>Your gallery couldn't open</h2><p>Your drawings stay on this device. Try opening them again.</p><button className="pill-button" onClick={() => void refresh()} data-testid="button-retry-gallery">Try again</button></div>
          ) : filtered.length ? (
            <div className="art-grid">
              {filtered.map(artwork => (
                <button className="art-card" key={artwork.id} onClick={() => selecting ? toggleArtworkSelection(artwork.id) : openArtwork(artwork)} data-testid={`card-artwork-${artwork.id}`}>
                  <div className="art-thumb">
                    {artwork.preview ? <img src={artwork.preview} alt={`${artwork.title} artwork preview`} /> : <div className="thumb-placeholder"><PenLine size={26} /></div>}
                    {selectedArtworkIds.includes(artwork.id) && <span className="selection-mark"><Check size={16} /></span>}
                  </div>
                  <div className="art-info"><div><div className="art-title">{artwork.title || 'Untitled Artwork'}</div><div className="art-dim">{artwork.width} × {artwork.height}px</div></div><span className="art-kebab" aria-hidden="true"><MoreHorizontal size={18} /></span></div>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-gallery">
              <div className="brand-mark"><PenLine size={18} /></div>
              <h2>{search ? 'Nothing by that name, yet.' : 'A blank page is a beginning.'}</h2>
              <p>{search ? 'Try another title, or clear your search.' : 'Make a small space for a big idea.'}</p>
              {search ? <button className="pill-button" onClick={() => setSearch('')} data-testid="button-clear-search">Clear search</button> : <button className="pill-button" onClick={() => setSheetOpen(true)} data-testid="button-start-drawing"><Plus size={17} />Start drawing</button>}
            </div>
          )}
        </section>
        <div className="bottom-create" aria-label="Gallery actions">
          <button title={selecting ? 'Done selecting' : 'Select artworks'} aria-label={selecting ? 'Done selecting artworks' : 'Select artworks'} onClick={() => { setSelecting(value => !value); setSelectedArtworkIds([]); }} data-testid="button-select-artwork">{selecting ? <X size={19} /> : <Check size={19} />}</button>
          <button title="New canvas" aria-label="New canvas" onClick={() => setSheetOpen(true)} data-testid="button-sheet-create"><FileImage size={19} /></button>
          <button title="Import artwork" aria-label="Import artwork" onClick={() => document.getElementById('import-artwork')?.click()} data-testid="button-import"><Copy size={18} /></button>
          <input id="import-artwork" type="file" accept="image/png,image/jpeg" hidden onChange={event => {
            const file = event.target.files?.[0];
            if (!file) return;
            const image = new Image();
            image.onload = () => {
              const width = Math.min(image.naturalWidth, 4096);
              const height = Math.min(image.naturalHeight, 4096);
              const imported: Artwork = { id: makeId(), title: file.name.replace(/\.[^.]+$/, ''), width, height, created: Date.now(), updated: Date.now(), layers: [makeLayer(1)], preview: undefined };
              setProject(imported);
              setActiveLayerId(imported.layers[0].id);
              setScreen('editor');
              setTimeout(() => {
                const canvas = canvasRefs.current[imported.layers[0].id];
                if (canvas) {
                  canvas.width = width; canvas.height = height;
                  canvas.getContext('2d')?.drawImage(image, 0, 0, width, height);
                  setTimeout(() => persist(imported), 80);
                }
              }, 120);
            };
            image.src = URL.createObjectURL(file);
            event.target.value = '';
          }} />
        </div>
        <button className="create-round" title="Create canvas" aria-label="Create canvas" onClick={() => setSheetOpen(true)} data-testid="button-create-fab"><Plus size={23} /></button>
      </div>
      {selecting && selectedArtworkIds.length > 0 && <button className="selection-delete" onClick={() => void deleteSelectedArtworks()} data-testid="button-delete-selected"><Trash2 size={16} />Delete {selectedArtworkIds.length} {selectedArtworkIds.length === 1 ? 'artwork' : 'artworks'}</button>}
      {sheetOpen && <NewCanvasSheet onClose={() => setSheetOpen(false)} onCreate={createArtwork} customWidth={customWidth} customHeight={customHeight} setCustomWidth={setCustomWidth} setCustomHeight={setCustomHeight} selectedPreset={selectedPreset} setSelectedPreset={setSelectedPreset} />}
    </main>
  );
}

function compositePreview(project: Artwork, layers: Layer[], refs: Record<string, HTMLCanvasElement | null>) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 500 / project.width, 500 / project.height);
  canvas.width = Math.max(1, Math.round(project.width * scale));
  canvas.height = Math.max(1, Math.round(project.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.fillStyle = '#fffefa';
  context.fillRect(0, 0, canvas.width, canvas.height);
  layers.forEach(layer => {
    const item = refs[layer.id];
    if (layer.visible && item) context.drawImage(item, 0, 0, canvas.width, canvas.height);
  });
  return canvas.toDataURL('image/jpeg', 0.82);
}

function NewCanvasSheet({ onClose, onCreate, customWidth, customHeight, setCustomWidth, setCustomHeight, selectedPreset, setSelectedPreset }: {
  onClose: () => void; onCreate: (title: string, width: number, height: number) => void; customWidth: string; customHeight: string;
  setCustomWidth: (value: string) => void; setCustomHeight: (value: string) => void; selectedPreset: number; setSelectedPreset: (value: number) => void;
}) {
  const createPreset = (preset: Preset, index: number) => { setSelectedPreset(index); onCreate(preset.name === 'Screen Size' ? 'Untitled Artwork' : preset.name === 'Untitled Canvas' ? 'Untitled Artwork' : preset.name, preset.width, preset.height); };
  const createCustom = () => {
    const width = Math.max(16, Math.min(8192, Math.floor(Number(customWidth) || 0)));
    const height = Math.max(16, Math.min(8192, Math.floor(Number(customHeight) || 0)));
    if (width >= 16 && height >= 16) onCreate('Untitled Artwork', width, height);
  };
  return (
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="new-canvas-title">
        <div className="sheet-handle" />
        <header className="sheet-head"><h2 id="new-canvas-title">New canvas</h2><button className="icon-button" onClick={onClose} aria-label="Close new canvas sheet" data-testid="button-close-new-canvas"><X size={18} /></button></header>
        <div className="preset-list">
          {presets.map((preset, index) => <button key={`${preset.name}-${preset.width}`} className={`preset-row ${selectedPreset === index ? 'selected' : ''}`} onClick={() => createPreset(preset, index)} data-testid={`button-preset-${index}`}>
            <span className="preset-label">{preset.name}</span><span className="preset-detail"><span>{preset.color}</span><span>{preset.detail}</span></span>
          </button>)}
        </div>
        <div className="custom-size">
          <p className="custom-title">Make a custom size</p>
          <div className="dimension-fields">
            <label>Width (px)<input type="number" min="16" max="8192" value={customWidth} onChange={event => setCustomWidth(event.target.value)} aria-label="Custom canvas width" data-testid="input-custom-width" /></label>
            <label>Height (px)<input type="number" min="16" max="8192" value={customHeight} onChange={event => setCustomHeight(event.target.value)} aria-label="Custom canvas height" data-testid="input-custom-height" /></label>
            <button className="pill-button" onClick={createCustom} data-testid="button-create-custom">Create</button>
          </div>
        </div>
        <p className="sheet-footer">Your canvases are stored privately on this device.</p>
      </section>
    </div>
  );
}

function LayersSheet({ project, activeLayerId, onClose, onAdd, onActive, onVisibility, onRename, onDelete, canvasRefs }: {
  project: Artwork; activeLayerId: string; onClose: () => void; onAdd: () => void; onActive: (id: string) => void;
  onVisibility: (id: string) => void; onRename: (id: string, name: string) => void; onDelete: (id: string) => void;
  canvasRefs: Record<string, HTMLCanvasElement | null>;
}) {
  const [menuId, setMenuId] = useState('');
  const [renameId, setRenameId] = useState('');
  return <>
    <div className="panel-overlay" onClick={onClose} />
    <section className="layers-panel" role="dialog" aria-modal="true" aria-label="Layers">
      <div className="sheet-handle" />
      <header className="layer-head"><h2>Layers</h2><div className="layer-actions">
        <div className="layer-menu">
          <button className="icon-button" aria-label="More layer actions" onClick={() => setMenuId(menuId === 'menu' ? '' : 'menu')} data-testid="button-layer-menu"><MoreHorizontal size={19} /></button>
          {menuId === 'menu' && <div className="menu-pop"><button onClick={() => { const layer = project.layers.find(item => item.id === activeLayerId); if (layer) onVisibility(layer.id); setMenuId(''); }}>Toggle active visibility</button><button onClick={() => { onDelete(activeLayerId); setMenuId(''); }}>Delete active layer</button></div>}
        </div>
        <button className="icon-button" aria-label="Add layer" onClick={onAdd} data-testid="button-add-layer"><Plus size={20} /></button>
      </div></header>
      {project.layers.slice().reverse().map(layer => <div key={layer.id} className={`layer-row ${activeLayerId === layer.id ? 'active' : ''}`} onClick={() => onActive(layer.id)} data-testid={`row-layer-${layer.id}`}>
        <div className="layer-preview">{canvasRefs[layer.id] && <canvas ref={element => {
          if (!element || !canvasRefs[layer.id]) return;
          const source = canvasRefs[layer.id]!;
          element.width = 150; element.height = 94;
          element.getContext('2d')?.drawImage(source, 0, 0, 150, 94);
        }} />}</div>
        {renameId === layer.id ? <input autoFocus className="layer-name" defaultValue={layer.name} aria-label="Rename layer" onBlur={event => { onRename(layer.id, event.target.value); setRenameId(''); }} onKeyDown={event => { if (event.key === 'Enter') { onRename(layer.id, event.currentTarget.value); setRenameId(''); } }} onClick={event => event.stopPropagation()} data-testid={`input-layer-name-${layer.id}`} /> :
          <button className="layer-name" onClick={event => { event.stopPropagation(); setRenameId(layer.id); }} aria-label={`Rename ${layer.name}`} data-testid={`button-rename-layer-${layer.id}`}>{layer.name}</button>}
        <button className="layer-vis" aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`} onClick={event => { event.stopPropagation(); onVisibility(layer.id); }} data-testid={`button-visibility-${layer.id}`}>{layer.visible ? <Eye size={17} /> : <EyeOff size={17} />}</button>
        {activeLayerId === layer.id && <span aria-hidden="true" style={{ fontSize: 10, marginRight: 3 }}>N</span>}
      </div>)}
      <div className="layer-row" style={{ opacity: .7 }}><div className="layer-preview" /><span className="layer-name">Background color</span><Check size={16} /></div>
      <p className="sheet-footer">Tap a layer to draw on it. Press its name to rename.</p>
    </section>
  </>;
}

function ColorPicker({ color, onChange, onClose }: { color: string; onChange: (color: string) => void; onClose: () => void }) {
  const swatches = ['#3b3935','#e76c5b','#e6a54a','#7b9a7c','#779eb1','#c7a7a0','#454c72','#d7d2c8','#ffffff','#171717'];
  const setFromWheel = (event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const hue = ((Math.atan2(event.clientY - rect.top - rect.height / 2, event.clientX - rect.left - rect.width / 2) * 180 / Math.PI + 360) % 360);
    onChange(`hsl(${Math.round(hue)}, 75%, 52%)`);
  };
  return <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="color-panel" role="dialog" aria-modal="true" aria-label="Color picker">
      <header className="sheet-head"><h3>Colors</h3><button className="icon-button" onClick={onClose} aria-label="Close colors" data-testid="button-close-colors"><X size={18} /></button></header>
      <p className="custom-title">A small palette to begin</p>
      <div className="color-wheel" onClick={setFromWheel} role="button" aria-label="Choose hue from color wheel" data-testid="color-wheel" />
      <div className="color-swatches">{swatches.map(swatch => <button key={swatch} className="swatch" style={{ background: swatch }} aria-label={`Choose ${swatch}`} onClick={() => onChange(swatch)} data-testid={`swatch-${swatch.slice(1)}`} />)}</div>
      <div className="hex-row"><span style={{ width: 28, height: 28, borderRadius: '50%', background: color, border: '2px solid white', boxShadow: '0 0 0 1px #d5d0c7' }} /><input aria-label="Hex color value" value={color.startsWith('#') ? color : '#6d8c9c'} onChange={event => { if (/^#[0-9a-f]{6}$/i.test(event.target.value)) onChange(event.target.value); }} data-testid="input-hex-color" /><button className="pill-button" onClick={onClose} data-testid="button-apply-color">Done</button></div>
    </section>
  </div>;
}

function Router() {
  return <ErrorBoundary resetKey={useLocation()[0]}><Switch><Route path="/" component={AppHome} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}
function Root() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}
export default Root;
