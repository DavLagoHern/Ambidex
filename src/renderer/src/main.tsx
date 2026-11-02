import { createRoot } from 'react-dom/client'
import './styles.css'

// La misma página sirve a la ventana principal, a las ventanas web flotantes (#web=<url>)
// y a los paneles sacados a otra ventana (#panel=<panel>&project=<id>)
const root = createRoot(document.getElementById('root')!)
const web = location.hash.match(/^#web=(.*)$/)
const panel = new URLSearchParams(location.hash.slice(1))
if (web) import('./WebWindow').then(({ default: WebWindow }) => root.render(<WebWindow initial={decodeURIComponent(web[1])} />))
else if (panel.get('panel') && panel.get('project'))
  import('./PanelWindow').then(({ default: PanelWindow }) => root.render(<PanelWindow projectId={panel.get('project')!} panel={panel.get('panel') as never} />))
else import('./App').then(({ default: App }) => root.render(<App />))
