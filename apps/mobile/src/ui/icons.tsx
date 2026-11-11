/**
 * The app's icons (Lucide), by meaning rather than by drawing, so a screen asks for "receipt" and the set can change in
 * one place. Icons are decorative: the control around one carries its label for screen readers.
 */
import {
  Activity,
  AlertTriangle,
  Banknote,
  Bell,
  Briefcase,
  Building2,
  CalendarDays,
  ChartLine,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  FileText,
  Inbox,
  Keyboard,
  Info,
  LayoutGrid,
  Lightbulb,
  Mic,
  List,
  type LucideIcon,
  House,
  PieChart,
  Plus,
  Receipt,
  ScanLine,
  Search,
  Settings,
  Square,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  Target,
  Trash2,
  TrendingUp,
  Upload,
  Wallet,
  WifiOff,
  X,
} from 'lucide-react-native';
import { useTheme } from './theme';

const ICONS = {
  home: House,
  transactions: List,
  add: Plus,
  budget: PieChart,
  more: LayoutGrid,
  search: Search,
  filter: SlidersHorizontal,
  close: X,
  check: Check,
  saved: CircleCheck,
  next: ChevronRight,
  back: ChevronLeft,
  expand: ChevronDown,
  review: Inbox,
  goals: Target,
  cashFlow: TrendingUp,
  calendar: CalendarDays,
  suggestions: Lightbulb,
  accounts: Wallet,
  receipt: Receipt,
  scan: ScanLine,
  business: Briefcase,
  notifications: Bell,
  data: ShieldCheck,
  rentals: Building2,
  payslips: Banknote,
  import: Upload,
  activity: Activity,
  settings: Settings,
  warning: AlertTriangle,
  info: Info,
  offline: WifiOff,
  delete: Trash2,
  category: Tag,
  document: FileText,
  explore: ChartLine,
  mic: Mic,
  stop: Square,
  keyboard: Keyboard,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 20,
  color,
  strokeWidth = 2,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const th = useTheme();
  const Glyph = ICONS[name];
  return (
    <Glyph
      size={size}
      color={color ?? th.text}
      strokeWidth={strokeWidth}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
