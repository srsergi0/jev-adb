/**
 * Phone perception: uiautomator XML -> compact, stable element model.
 * Password fields are masked before anything leaves the device model.
 */

export interface PhoneElement {
  ref: string; // p1, p2, ... in dump order
  cls: string; // short class name, e.g. Button
  text: string;
  desc: string; // content-desc
  resId: string;
  clickable: boolean;
  password: boolean;
  bounds: [number, number, number, number]; // x1,y1,x2,y2
  center: [number, number];
}

export interface PhoneScreen {
  serial: string;
  elements: PhoneElement[];
  /** Fullscreen-hash proxy: length + first/last refs, used for change detection. */
  fingerprint: string;
  truncated: boolean;
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : '';
}

function shortClass(c: string): string {
  const parts = c.split('.');
  return parts[parts.length - 1] || c;
}

function parseBounds(b: string): [number, number, number, number] {
  const m = b.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return [0, 0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

const SECRET_HINT = /password|contrase|passwd|pwd|pin|otp|cardnumber|creditcard/i;
// Layout-only containers with no label carry no signal for grounding (clickable cards are kept).
const LAYOUT_CONTAINER = /^(FrameLayout|LinearLayout|RelativeLayout|ConstraintLayout|ViewGroup|ScrollView|HorizontalScrollView|RecyclerView|ListView|GridView|ViewPager|DrawerLayout|CoordinatorLayout)$/;

export function parseDump(serial: string, xml: string, maxElements = 150): PhoneScreen {
  const tags = xml.match(/<node\b[^>]*\/?>/g) ?? [];
  const elements: PhoneElement[] = [];
  let i = 0;
  for (const tag of tags) {
    if (elements.length >= maxElements) break;
    const cls = shortClass(attr(tag, 'class'));
    if (!cls || cls === 'hierarchy') continue;
    const bounds = parseBounds(attr(tag, 'bounds'));
    if (bounds[2] <= 0 || bounds[3] <= 0) continue; // zero-area nodes carry no signal
    const clickable = attr(tag, 'clickable') === 'true';
    const text = attr(tag, 'text');
    const desc = attr(tag, 'content-desc');
    const password = attr(tag, 'password') === 'true' || SECRET_HINT.test(`${attr(tag, 'resource-id')} ${cls}`);
    if (!clickable && !password && !text && !desc && LAYOUT_CONTAINER.test(cls)) continue;
    i++;
    elements.push({
      ref: `p${i}`,
      cls,
      text: password ? '••••' : text.slice(0, 80),
      desc: password ? '' : desc.slice(0, 80),
      resId: attr(tag, 'resource-id').slice(0, 120),
      clickable,
      password,
      bounds,
      center: [Math.round((bounds[0] + bounds[2]) / 2), Math.round((bounds[1] + bounds[3]) / 2)],
    });
  }
  const fingerprint = `${elements.length}:${elements[0]?.ref ?? '-'}:${elements[elements.length - 1]?.ref ?? '-'}:${xml.length}`;
  return { serial, elements, fingerprint, truncated: tags.length > elements.length };
}

function label(e: PhoneElement): string {
  const name = e.text || e.desc || e.resId.split('/').pop() || e.cls;
  return `${e.ref} ${e.cls} "${name.slice(0, 60)}" @${e.center[0]},${e.center[1]}${e.clickable ? ' [tappable]' : ''}${e.password ? ' [secret]' : ''}`;
}

/** Compact state text for JEV. Secrets never appear (masked at parse time). */
export function screenState(screen: PhoneScreen, extra?: string): string {
  const lines = [`Device ${screen.serial} · ${screen.elements.length} elements${screen.truncated ? ' (truncated)' : ''}`];
  for (const e of screen.elements) lines.push(label(e));
  if (extra) lines.push(`Context: ${extra.slice(0, 500)}`);
  return lines.join('\n');
}

/** Find element by ref. */
export function byRef(screen: PhoneScreen, ref: string): PhoneElement | null {
  return screen.elements.find((e) => e.ref === ref) ?? null;
}
