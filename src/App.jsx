import { useEffect, useMemo, useRef, useState } from 'react';
import AuthScreen from './AuthScreen.jsx';
import { apiRequest } from './api.js';

const networks = [
  { id: 'facebook', name: 'Facebook', mark: 'f', className: 'facebook' },
  { id: 'instagram', name: 'Instagram', mark: '◎', className: 'instagram' },
  { id: 'threads', name: 'Threads', mark: '@', className: 'threads' },
  { id: 'tiktok', name: 'TikTok', mark: '♪', className: 'tiktok' },
  { id: 'youtube', name: 'YouTube', mark: '▶', className: 'youtube' },
  { id: 'linkedin', name: 'LinkedIn', mark: 'in', className: 'linkedin' },
  { id: 'x', name: 'X', mark: 'X', className: 'x' },
];

const navigation = [
  { id: 'Inicio', icon: '⌂' },
  { id: 'Calendario', icon: '▦' },
  { id: 'Publicaciones', icon: '▤' },
  { id: 'Cuentas sociales', icon: '◎' },
  { id: 'Espacios y marcas', icon: '▣' },
];

const statusTabs = [
  { id: 'all', label: 'Todas' },
  { id: 'draft-undated', label: 'Borrador sin fecha' },
  { id: 'draft-planned', label: 'Borrador planificado' },
  { id: 'scheduled', label: 'Programadas · API' },
  { id: 'published', label: 'Publicadas · API' },
  { id: 'failed', label: 'Fallidas · API' },
];
const postDraftState = (post) => post.status === 'draft'
  ? post.date ? 'draft-planned' : 'draft-undated'
  : post.status;

const dateAtOffset = (offset, hour = 12) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(hour, 0, 0, 0);
  return date;
};

const getNetwork = (id) => networks.find((network) => network.id === id);
const formatDate = (date, options = { day: 'numeric', month: 'short' }) =>
  new Intl.DateTimeFormat('es-ES', options).format(date);
const formatTime = (date) =>
  new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(date);
const toDateInput = (date) => {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 16);
};
const zonedParts = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map(({ type, value }) => [type, value]));
};
const dateKeyInZone = (date, timeZone) => {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const dateTimeInputInZone = (date, timeZone) => {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};
const dateFromZonedInput = (value, timeZone) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const targetAsUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  let timestamp = targetAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = zonedParts(new Date(timestamp), timeZone);
    const representedAsUtc = Date.UTC(
      Number(local.year),
      Number(local.month) - 1,
      Number(local.day),
      Number(local.hour),
      Number(local.minute),
    );
    const offset = representedAsUtc - timestamp;
    const next = targetAsUtc - offset;
    if (next === timestamp) break;
    timestamp = next;
  }
  return new Date(timestamp);
};
const formatInZone = (value, timeZone, options) => value
  ? new Intl.DateTimeFormat('es-ES', { ...options, timeZone }).format(value)
  : 'Sin fecha';
const formatOptionsByType = {
  text: 'Texto',
  image: 'Imagen',
  video: 'Video',
  carousel: 'Carrusel',
  story: 'Historia',
  reel: 'Reel',
  short: 'Short',
};
const timezoneOptions = [
  'America/Mexico_City',
  'America/Tijuana',
  'America/Los_Angeles',
  'America/New_York',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Argentina/Buenos_Aires',
  'Europe/Madrid',
  'UTC',
];

function NetworkMark({ networkId, className = '' }) {
  const network = getNetwork(networkId);
  if (!network) return null;
  return (
    <span className={`network-mark ${network.className} ${className}`} aria-hidden="true">
      {network.mark}
    </span>
  );
}

function WorkspaceApp({ user, initialData, initialWorkspaces, onLogout, onWorkspaceChange }) {
  const [activePage, setActivePage] = useState('Inicio');
  const [showComposer, setShowComposer] = useState(false);
  const [showAccountPicker, setShowAccountPicker] = useState(false);
  const [selectedNetwork, setSelectedNetwork] = useState(null);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [logoutError, setLogoutError] = useState('');
  const [notification, setNotification] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [facebookConnectionAvailable, setFacebookConnectionAvailable] = useState(false);
  const [facebookConnectionMissing, setFacebookConnectionMissing] = useState([]);
  const [youtubeConnectionAvailable, setYoutubeConnectionAvailable] = useState(false);
  const [youtubeConnectionMissing, setYoutubeConnectionMissing] = useState([]);
  const [facebookPageAssignments, setFacebookPageAssignments] = useState({});
  const [facebookPageSelectionError, setFacebookPageSelectionError] = useState('');
  const [savingFacebookPages, setSavingFacebookPages] = useState(false);
  const [youtubeChannelAssignments, setYoutubeChannelAssignments] = useState({});
  const [youtubeChannelSelectionError, setYoutubeChannelSelectionError] = useState('');
  const [savingYoutubeChannels, setSavingYoutubeChannels] = useState(false);
  const [accountSummary, setAccountSummary] = useState({ registeredAccounts: 0, officialConnections: 0 });
  const [accountSummaryVersion, setAccountSummaryVersion] = useState(0);
  const [theme, setTheme] = useState('light');
  const [compact, setCompact] = useState(false);
  const [activeUser, setActiveUser] = useState({ ...user, image: user.image || '' });
  const activeUserId = user.id;
  const facebookReturnHandling = useRef(false);
  const [userData, setUserData] = useState({
    [user.id]: {
      accounts: initialData.accounts,
      posts: initialData.posts.map((post) => ({ ...post, date: post.date ? new Date(post.date) : null })),
    },
  });
  const [profileNameInput, setProfileNameInput] = useState('');
  const [postMenuId, setPostMenuId] = useState(null);
  const [accountMenuId, setAccountMenuId] = useState(null);
  const [editPostText, setEditPostText] = useState('');
  const [editPostTitle, setEditPostTitle] = useState('');
  const [editPostDescription, setEditPostDescription] = useState('');
  const [editPostHashtags, setEditPostHashtags] = useState('');
  const [editPostNetworkContent, setEditPostNetworkContent] = useState({});
  const [editPostDate, setEditPostDate] = useState('');
  const [editPostNetworks, setEditPostNetworks] = useState([]);
  const [editPostFormat, setEditPostFormat] = useState('text');
  const [editPostUndated, setEditPostUndated] = useState(false);
  const [copyBrandId, setCopyBrandId] = useState('');
  const [connectionWorkspaceId, setConnectionWorkspaceId] = useState('');
  const [connectionBrandId, setConnectionBrandId] = useState('');
  const [editAccountName, setEditAccountName] = useState('');
  const [accountPreferenceEnabled, setAccountPreferenceEnabled] = useState(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [publicationTab, setPublicationTab] = useState('all');
  const [publicationFilters, setPublicationFilters] = useState({
    brandId: '',
    networkId: '',
    format: 'all',
    from: '',
    to: '',
  });
  const [calendarDate, setCalendarDate] = useState(() => new Date());
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => new Date());
  const [calendarMode, setCalendarMode] = useState('month');
  const [calendarFilters, setCalendarFilters] = useState({ brandId: '', networkId: '', status: 'all', format: 'all' });
  const [calendarNotes, setCalendarNotes] = useState([]);
  const [calendarNoteText, setCalendarNoteText] = useState('');
  const [calendarReminderAt, setCalendarReminderAt] = useState('');
  const [calendarNoteEditingId, setCalendarNoteEditingId] = useState(null);
  const [calendarNoteError, setCalendarNoteError] = useState('');
  const [draggedPostId, setDraggedPostId] = useState(null);
  const [draftText, setDraftText] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftHashtags, setDraftHashtags] = useState('');
  const [draftNetworkContent, setDraftNetworkContent] = useState({});
  const [draftDate, setDraftDate] = useState(() => toDateInput(dateAtOffset(1)));
  const [draftNetworks, setDraftNetworks] = useState([]);
  const [draftFormat, setDraftFormat] = useState('text');
  const [draftUndated, setDraftUndated] = useState(false);
  const [draftFileName, setDraftFileName] = useState('');
  const [accountDisplayName, setAccountDisplayName] = useState('');
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [activeBrandId, setActiveBrandId] = useState(
    initialWorkspaces.find((item) => item.id === initialData.workspaceId)?.brands[0]?.id || '',
  );
  const [draftBrandId, setDraftBrandId] = useState(
    initialWorkspaces.find((item) => item.id === initialData.workspaceId)?.brands[0]?.id || '',
  );
  const [workspaceName, setWorkspaceName] = useState('');
  const [brandName, setBrandName] = useState('');
  const [brandLogoUrl, setBrandLogoUrl] = useState('');
  const [brandDescription, setBrandDescription] = useState('');
  const [brandWebsite, setBrandWebsite] = useState('');
  const [brandPrimaryColor, setBrandPrimaryColor] = useState('#087fb7');
  const [brandAccentColor, setBrandAccentColor] = useState('#44b9e2');
  const [brandTimezone, setBrandTimezone] = useState('America/Mexico_City');
  const [workspaceError, setWorkspaceError] = useState('');
  const activeUserData = userData[activeUserId] || { accounts: [], posts: [] };
  const { accounts, posts } = activeUserData;
  const activeWorkspace = workspaces.find((item) => item.id === initialData.workspaceId);
  const activeBrand = activeWorkspace?.brands.find((item) => item.id === activeBrandId);
  const brandAccounts = accounts.filter((account) => account.brandId === activeBrandId);
  const brandTimezoneValue = activeBrand?.settings?.timezone || 'America/Mexico_City';
  const getBrandTimezone = (brandId) => activeWorkspace?.brands.find((brand) => brand.id === brandId)?.settings?.timezone || brandTimezoneValue;
  const calendarBrandId = calendarFilters.brandId || activeBrandId;
  const calendarTimezoneValue = activeWorkspace?.brands.find((brand) => brand.id === calendarBrandId)?.settings?.timezone || brandTimezoneValue;

  const updateActiveUserData = (key, updater) => {
    setUserData((current) => {
      const data = current[activeUserId] || { accounts: [], posts: [] };
      const value = typeof updater === 'function' ? updater(data[key]) : updater;
      return { ...current, [activeUserId]: { ...data, [key]: value } };
    });
  };
  const setAccounts = (updater) => updateActiveUserData('accounts', updater);
  const setPosts = (updater) => updateActiveUserData('posts', updater);

  const today = new Date();
  const todayLabel = new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(today);

  const notify = (message) => {
    if (notificationsEnabled) setNotification(message);
  };

  useEffect(() => {
    if (!activeBrandId) {
      setAccountSummary({ registeredAccounts: 0, officialConnections: 0 });
      return undefined;
    }
    let current = true;
    const query = new URLSearchParams({
      workspaceId: initialData.workspaceId,
      brandId: activeBrandId,
    });
    apiRequest(`/connections/summary?${query}`)
      .then((summary) => {
        if (current) setAccountSummary(summary);
      })
      .catch((error) => {
        if (current) notify(`No se pudieron actualizar los contadores de cuentas: ${error.message}`);
      });
    return () => { current = false; };
  }, [activeBrandId, accountSummaryVersion, initialData.workspaceId]);

  useEffect(() => {
    apiRequest('/auth/methods')
      .then(({ google }) => setGoogleEnabled(Boolean(google)))
      .catch((error) => notify(`No se pudo comprobar la configuración de Google: ${error.message}`));
    apiRequest('/connections/methods')
      .then(({ facebook, youtube }) => {
        setFacebookConnectionAvailable(Boolean(facebook?.available));
        setFacebookConnectionMissing(facebook?.missing || []);
        setYoutubeConnectionAvailable(Boolean(youtube?.available));
        setYoutubeConnectionMissing(youtube?.missing || []);
      })
      .catch((error) => notify(`No se pudo comprobar la configuración de conexiones: ${error.message}`));
    const authResult = new URLSearchParams(window.location.search).get('auth');
    const messages = {
      'google-linked': 'La cuenta de Google se vinculó de forma segura.',
      'google-link-required': 'Inicia sesión con tu correo y contraseña antes de vincular Google.',
      'google-link-session-required': 'La sesión venció durante la vinculación. Inicia sesión e inténtalo de nuevo.',
      'google-conflict': 'Esa cuenta de Google ya está vinculada a otro usuario.',
      'google-unverified': 'Google no confirmó un correo verificado para esta cuenta.',
      'google-error': 'No se pudo completar el inicio de sesión oficial de Google.',
    };
    if (messages[authResult]) {
      setNotification(messages[authResult]);
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (facebookReturnHandling.current) return;
    facebookReturnHandling.current = true;
    const connectionQuery = new URLSearchParams(window.location.search);
    const connectionResult = connectionQuery.get('connection');
    const clearConnectionQuery = () => {
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.delete('connection');
      currentUrl.searchParams.delete('selection');
      currentUrl.searchParams.delete('count');
      currentUrl.searchParams.delete('reason');
      currentUrl.searchParams.delete('event');
      window.history.replaceState({}, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
    };
    const openFacebookSelection = (selection) => {
      const defaults = Object.fromEntries(selection.pages.map((page) => [page.id, {
        selected: false,
        workspaceId: selection.workspaceId,
        brandId: selection.brandId,
      }]));
      setFacebookPageAssignments(defaults);
      setDialog({ type: 'facebook-page-selection', selection });
    };
    const openYoutubeSelection = (selection) => {
      const defaultWorkspaceId = initialData.workspaceId;
      const defaultBrandId = initialWorkspaces.find((item) => item.id === defaultWorkspaceId)?.brands[0]?.id || '';
      const defaults = Object.fromEntries(selection.channels.map((channel) => [channel.id, {
        selected: false,
        workspaceId: defaultWorkspaceId,
        brandId: defaultBrandId,
      }]));
      setYoutubeChannelAssignments(defaults);
      setDialog({ type: 'youtube-channel-selection', selection });
    };
    const errorMessages = {
      cancelled: 'Cancelaste la autorización de Facebook.',
      'invalid-state': 'Meta regresó una autorización cuyo estado no se pudo validar. Inicia de nuevo la conexión.',
      'state-expired': 'La autorización de Facebook tardó demasiado y venció. Inicia de nuevo la conexión.',
      'session-expired': 'La sesión local venció durante la autorización. Inicia sesión de nuevo.',
      'not-configured': 'La conexión requiere configurar las credenciales de Meta y la clave local de cifrado.',
      'permissions-missing': 'Meta no concedió todos los permisos solicitados para listar páginas y administrar publicaciones.',
      'no-manageable-pages': 'Meta autorizó la cuenta, pero no devolvió páginas administrables.',
      'provider-error': 'Meta rechazó o no pudo completar la conexión.',
    };
    const youtubeErrorMessages = {
      cancelled: 'Cancelaste la autorización de YouTube.',
      'invalid-state': 'Google regresó una autorización cuyo estado no se pudo validar. Inicia de nuevo la conexión.',
      'state-expired': 'La autorización de YouTube tardó demasiado y venció. Inicia de nuevo la conexión.',
      'session-expired': 'La sesión local venció durante la autorización. Inicia sesión de nuevo.',
      'not-configured': 'La conexión requiere las credenciales OAuth de Google y la clave local de cifrado.',
      'no-channels': 'Google autorizó la cuenta, pero no devolvió canales de YouTube administrables.',
      'refresh-token-required': 'Google no devolvió autorización renovable. Retira LOP de las conexiones de tu cuenta Google y vuelve a autorizar.',
      'provider-error': 'Google rechazó o no pudo completar la conexión de YouTube.',
    };
    const showOAuthFailure = async () => {
      let event = null;
      const eventId = connectionQuery.get('event');
      if (eventId) {
        try {
          ({ event } = await apiRequest(`/connections/facebook/oauth-events/${encodeURIComponent(eventId)}`));
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      const reason = connectionQuery.get('reason');
      const details = event
        ? [
          event.providerMessage,
          event.providerCode ? `Código Meta: ${event.providerCode}${event.providerSubcode ? `/${event.providerSubcode}` : ''}.` : '',
          event.stage ? `Etapa: ${event.stage}.` : '',
        ].filter(Boolean).join(' ')
        : '';
      setNotification(`${errorMessages[reason] || 'No se pudo completar la conexión oficial de Facebook.'}${details ? ` ${details}` : ''}`);
      clearConnectionQuery();
    };
    const recoverPendingSelection = async () => {
      const { pending } = await apiRequest('/connections/facebook/page-selections/pending');
      if (pending.length) {
        openFacebookSelection(pending[0]);
        setNotification('Se recuperó una selección pendiente de Facebook. Elige las páginas que deseas conectar.');
        return true;
      }
      return false;
    };
    const recoverPendingYouTubeSelection = async () => {
      const { pending } = await apiRequest('/connections/youtube/selections/pending');
      if (pending.length) {
        openYoutubeSelection(pending[0]);
        setNotification('Se recuperó una selección pendiente de YouTube. Elige los canales que deseas conectar.');
        return true;
      }
      return false;
    };
    const handleFacebookReturn = async () => {
      try {
        if (connectionResult === 'youtube-select') {
          const selectionId = connectionQuery.get('selection');
          if (selectionId) {
            try {
              const { selection } = await apiRequest(`/connections/youtube/selections/${encodeURIComponent(selectionId)}`);
              openYoutubeSelection(selection);
              clearConnectionQuery();
              return;
            } catch (error) {
              setNotification(`No se pudo cargar la selección indicada (${error.message}). Se buscarán selecciones aún vigentes.`);
            }
          }
          if (await recoverPendingYouTubeSelection()) {
            clearConnectionQuery();
            return;
          }
          setNotification((message) => message || 'No hay una selección vigente de canales. La selección pudo vencer; inicia de nuevo la conexión.');
          return;
        }
        if (connectionResult === 'youtube-error') {
          setNotification(youtubeErrorMessages[connectionQuery.get('reason')]
            || 'No se pudo completar la conexión oficial de YouTube.');
          clearConnectionQuery();
          return;
        }
        if (connectionResult === 'facebook-select') {
          const selectionId = connectionQuery.get('selection');
          if (selectionId) {
            try {
              const { selection } = await apiRequest(`/connections/facebook/page-selections/${encodeURIComponent(selectionId)}`);
              openFacebookSelection(selection);
              clearConnectionQuery();
              const eventId = connectionQuery.get('event');
              if (eventId) {
                try {
                  const { event } = await apiRequest(`/connections/facebook/oauth-events/${encodeURIComponent(eventId)}`);
                  if (event.providerMessage) {
                    const providerCode = event.providerCode
                      ? ` Código Meta: ${event.providerCode}${event.providerSubcode ? `/${event.providerSubcode}` : ''}.`
                      : '';
                    setNotification(`${event.providerMessage}${providerCode}`);
                  }
                } catch (error) {
                  if (error.status !== 404) {
                    setNotification(`Las páginas están disponibles, pero no se pudo consultar el diagnóstico de Business Manager: ${error.message}`);
                  }
                }
              }
              return;
            } catch (error) {
              setNotification(`No se pudo cargar la selección indicada (${error.message}). Se buscarán selecciones aún vigentes.`);
            }
          }
          if (await recoverPendingSelection()) {
            clearConnectionQuery();
            return;
          }
          setNotification((message) => message || 'No hay una selección vigente de páginas. La selección pudo vencer; inicia de nuevo la conexión.');
          return;
        }
        if (connectionResult === 'facebook-connected') {
          const count = Number(connectionQuery.get('count')) || 0;
          setNotification(`Facebook conectado. Se guardaron ${count} página(s) de forma segura en SQLite.`);
          clearConnectionQuery();
          return;
        }
        if (connectionResult === 'facebook-error') {
          await showOAuthFailure();
          return;
        }
        if (!(await recoverPendingSelection())) await recoverPendingYouTubeSelection();
      } catch (error) {
        setNotification(`No se pudo recuperar el resultado de Facebook: ${error.message}. El resultado temporal se conservará; vuelve a cargar la página para reintentarlo.`);
      }
    };
    void handleFacebookReturn();
  }, []);
  const persistenceQueues = useRef({ accounts: Promise.resolve(), posts: Promise.resolve() });
  const persistedData = useRef({ accounts, posts });
  const desiredData = useRef({ accounts, posts });
  const queuePersistence = (collection) => {
    const pending = persistenceQueues.current[collection].then(async () => {
      let savedItems = persistedData.current[collection];
      while (JSON.stringify(savedItems) !== JSON.stringify(desiredData.current[collection])) {
        const nextItems = desiredData.current[collection];
        const savedById = new Map(savedItems.map((item) => [item.id, item]));
        const nextById = new Map(nextItems.map((item) => [item.id, item]));
        for (const item of nextItems) {
          if (JSON.stringify(savedById.get(item.id)) !== JSON.stringify(item)) {
            await apiRequest(`/data/${collection}/${encodeURIComponent(item.id)}`, {
              method: 'PUT',
              body: JSON.stringify(item),
            });
          }
        }
        for (const item of savedItems) {
          if (!nextById.has(item.id)) {
            await apiRequest(`/data/${collection}/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
          }
        }
        savedItems = nextItems;
        persistedData.current[collection] = nextItems;
      }
    });
    persistenceQueues.current[collection] = pending.catch((error) => {
      notify(`No se guardaron los cambios: ${error.message}`);
      return false;
    });
    return persistenceQueues.current[collection];
  };

  useEffect(() => {
    desiredData.current.accounts = accounts;
    queuePersistence('accounts');
  }, [accounts]);

  useEffect(() => {
    desiredData.current.posts = posts;
    queuePersistence('posts');
  }, [posts]);

  const allPosts = posts;
  const filteredCalendarPosts = useMemo(() => allPosts.filter((post) => (
    (!calendarFilters.brandId || post.brandId === calendarFilters.brandId)
    && (!calendarFilters.networkId || post.networkIds?.includes(calendarFilters.networkId) || post.networkId === calendarFilters.networkId)
    && (calendarFilters.status === 'all' || post.status === calendarFilters.status)
    && (calendarFilters.format === 'all' || post.format === calendarFilters.format)
  )), [allPosts, calendarFilters]);
  const visiblePosts = useMemo(() => {
    return allPosts
      .filter((post) => publicationTab === 'all' || postDraftState(post) === publicationTab)
      .filter((post) => !publicationFilters.brandId || post.brandId === publicationFilters.brandId)
      .filter((post) => !publicationFilters.networkId
        || post.networkIds?.includes(publicationFilters.networkId)
        || post.networkId === publicationFilters.networkId)
      .filter((post) => publicationFilters.format === 'all' || post.format === publicationFilters.format)
      .filter((post) => {
        if (!publicationFilters.from && !publicationFilters.to) return true;
        if (!post.date) return false;
        const postDate = dateKeyInZone(post.date, getBrandTimezone(post.brandId));
        return (!publicationFilters.from || postDate >= publicationFilters.from)
          && (!publicationFilters.to || postDate <= publicationFilters.to);
      })
      .sort((first, second) => (second.date?.getTime() || 0) - (first.date?.getTime() || 0));
  }, [allPosts, publicationTab, publicationFilters, calendarTimezoneValue]);
  const visiblePostsByBrand = useMemo(() => activeWorkspace?.brands
    .map((brand) => ({
      brand,
      posts: visiblePosts.filter((post) => post.brandId === brand.id),
    }))
    .filter((group) => group.posts.length) || [], [activeWorkspace?.brands, visiblePosts]);

  const calendarCells = useMemo(() => {
    const parts = zonedParts(calendarDate, calendarTimezoneValue);
    const year = Number(parts.year);
    const month = Number(parts.month) - 1;
    const day = Number(parts.day);
    const anchor = new Date(Date.UTC(year, month, day));
    const firstDay = new Date(Date.UTC(year, month, 1));
    const mondayOffset = (firstDay.getUTCDay() + 6) % 7;
    const start = calendarMode === 'week'
      ? new Date(Date.UTC(year, month, day - ((anchor.getUTCDay() + 6) % 7)))
      : calendarMode === 'day' ? anchor : new Date(Date.UTC(year, month, 1 - mondayOffset));
    const count = calendarMode === 'day' ? 1 : calendarMode === 'week' ? 7 : 42;
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + index);
      const dateKey = date.toISOString().slice(0, 10);
      return dateFromZonedInput(`${dateKey}T12:00`, calendarTimezoneValue);
    });
  }, [calendarDate, calendarMode, calendarTimezoneValue]);

  const postsForDate = (date) => filteredCalendarPosts.filter((post) =>
    post.date && dateKeyInZone(post.date, calendarTimezoneValue) === dateKeyInZone(date, calendarTimezoneValue)
      && (!calendarFilters.brandId || post.brandId === calendarFilters.brandId)
      && (!calendarFilters.networkId || post.networkIds?.includes(calendarFilters.networkId) || post.networkId === calendarFilters.networkId)
      && (calendarFilters.status === 'all' || post.status === calendarFilters.status)
      && (calendarFilters.format === 'all' || post.format === calendarFilters.format),
  );

  useEffect(() => {
    if (activePage !== 'Calendario' || !activeBrandId || !activeWorkspace) return undefined;
    let active = true;
    const [year, month] = dateKeyInZone(calendarDate, calendarTimezoneValue).split('-').map(Number);
    const fromKey = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
    const toKey = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    apiRequest(`/calendar/notes?brandId=${encodeURIComponent(calendarBrandId)}&from=${fromKey}&to=${toKey}`)
      .then(({ notes }) => {
        if (active) setCalendarNotes(notes);
      })
      .catch((error) => {
        if (active) setCalendarNoteError(`No se pudieron cargar las notas: ${error.message}`);
      });
    return () => { active = false; };
  }, [activePage, calendarBrandId, activeWorkspace?.id, dateKeyInZone(calendarDate, calendarTimezoneValue).slice(0, 7), calendarTimezoneValue]);

  const savePostImmediately = async (updatedPost) => {
    const saved = await apiRequest(`/data/posts/${encodeURIComponent(updatedPost.id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...updatedPost,
        date: updatedPost.date ? updatedPost.date.toISOString() : null,
      }),
    });
    const nextPosts = posts.map((post) => post.id === saved.id
      ? { ...saved, date: saved.date ? new Date(saved.date) : null }
      : post);
    persistedData.current.posts = nextPosts;
    desiredData.current.posts = nextPosts;
    setPosts(nextPosts);
    return saved;
  };

  const saveCalendarNote = async (event) => {
    event.preventDefault();
    setCalendarNoteError('');
    if (!calendarNoteText.trim()) {
      setCalendarNoteError('Escribe el texto de la nota.');
      return;
    }
    const date = dateKeyInZone(selectedCalendarDate, calendarTimezoneValue);
    const reminderDate = calendarReminderAt
      ? dateFromZonedInput(calendarReminderAt, calendarTimezoneValue)
      : null;
    if (calendarReminderAt && (!reminderDate || Number.isNaN(reminderDate.getTime()))) {
      setCalendarNoteError('La fecha del recordatorio no es válida.');
      return;
    }
    try {
      const note = calendarNoteEditingId
        ? await apiRequest(`/calendar/notes/${encodeURIComponent(calendarNoteEditingId)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            date,
            text: calendarNoteText.trim(),
            reminderAt: reminderDate?.toISOString() || null,
          }),
        })
        : await apiRequest('/calendar/notes', {
          method: 'POST',
          body: JSON.stringify({
            brandId: calendarBrandId,
            date,
            text: calendarNoteText.trim(),
            reminderAt: reminderDate?.toISOString() || null,
          }),
        });
      setCalendarNotes((current) => [
        ...current.filter((item) => item.id !== note.id),
        note,
      ].sort((first, second) => first.date.localeCompare(second.date)));
      setCalendarNoteText('');
      setCalendarReminderAt('');
      setCalendarNoteEditingId(null);
      notify('Nota guardada en SQLite.');
    } catch (error) {
      setCalendarNoteError(`No se pudo guardar la nota: ${error.message}`);
    }
  };

  const editCalendarNote = (note) => {
    setCalendarNoteEditingId(note.id);
    setCalendarNoteText(note.text);
    setCalendarReminderAt(note.reminderAt ? dateTimeInputInZone(new Date(note.reminderAt), calendarTimezoneValue) : '');
  };

  const deleteCalendarNote = async (noteId) => {
    setCalendarNoteError('');
    try {
      await apiRequest(`/calendar/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
      setCalendarNotes((current) => current.filter((note) => note.id !== noteId));
      if (calendarNoteEditingId === noteId) {
        setCalendarNoteEditingId(null);
        setCalendarNoteText('');
        setCalendarReminderAt('');
      }
      notify('Nota eliminada.');
    } catch (error) {
      setCalendarNoteError(`No se pudo eliminar la nota: ${error.message}`);
    }
  };

  const exportCalendarCsv = () => {
    const escapeCsv = (value) => {
      let text = String(value ?? '');
      if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = [
      ['Tipo', 'Fecha', 'Hora', 'Zona horaria', 'Marca', 'Redes', 'Estado interno', 'Formato', 'Texto', 'Recordatorio'],
      ...filteredCalendarPosts.map((post) => [
        'Borrador',
        post.date ? dateKeyInZone(post.date, getBrandTimezone(post.brandId)) : '',
        post.date ? formatInZone(post.date, getBrandTimezone(post.brandId), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '',
        getBrandTimezone(post.brandId),
        activeWorkspace?.brands.find((brand) => brand.id === post.brandId)?.name || '',
        (post.networkIds?.length ? post.networkIds : post.networkId ? [post.networkId] : []).map((id) => getNetwork(id)?.name || id).join(', '),
        'Borrador local (no publicado)',
        formatOptionsByType[post.format] || post.format,
        post.text,
        '',
      ]),
      ...calendarNotes.map((note) => [
        'Nota',
        note.date,
        '',
        getBrandTimezone(note.brandId),
        activeWorkspace?.brands.find((brand) => brand.id === note.brandId)?.name || '',
        '',
        'Nota de calendario',
        '',
        note.text,
        note.reminderAt ? formatInZone(new Date(note.reminderAt), getBrandTimezone(note.brandId), { dateStyle: 'short', timeStyle: 'short' }) : '',
      ]),
    ];
    const csv = `\uFEFF${rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `lop-calendario-${dateKeyInZone(calendarDate, calendarTimezoneValue)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleCalendarDrop = async (event, date, hour = null) => {
    event.preventDefault();
    const postId = event.dataTransfer.getData('text/plain') || draggedPostId;
    setDraggedPostId(null);
    const post = allPosts.find((item) => item.id === postId);
    if (!post || !date) return;
    const dateKey = dateKeyInZone(date, calendarTimezoneValue);
    const previousTime = post.date ? zonedParts(post.date, calendarTimezoneValue) : null;
    const targetHour = hour ?? Number(previousTime?.hour || '09');
    const targetMinute = hour === null ? previousTime?.minute || '00' : '00';
    const movedDate = dateFromZonedInput(`${dateKey}T${String(targetHour).padStart(2, '0')}:${targetMinute}`, calendarTimezoneValue);
    if (!movedDate || Number.isNaN(movedDate.getTime())) {
      notify('No se pudo calcular esa hora en la zona horaria de la marca.');
      return;
    }
    try {
      await savePostImmediately({ ...post, date: movedDate });
      setSelectedCalendarDate(date);
      notify('Fecha y hora del borrador guardadas en SQLite.');
    } catch (error) {
      notify(`No se pudo guardar el cambio de fecha: ${error.message}`);
    }
  };

  useEffect(() => {
    const handleOutsideClick = (event) => {
      if (!event.target.closest('.profile-menu-wrap, .post-menu-wrap, .account-menu-wrap')) {
        setShowProfileMenu(false);
        setPostMenuId(null);
        setAccountMenuId(null);
      }
    };
    const handleEscape = (event) => {
      if (event.key !== 'Escape') return;
      setShowProfileMenu(false);
      setPostMenuId(null);
      setAccountMenuId(null);
      setShowComposer(false);
      setShowAccountPicker(false);
      setShowSettings(false);
      setDialog(null);
      setSelectedNetwork(null);
    };
    document.addEventListener('pointerdown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const goToPage = (page) => {
    setActivePage(page);
    setShowProfileMenu(false);
    setNotification('');
  };

  const openComposer = (date = null, undated = false) => {
    setDraftText('');
    setDraftTitle('');
    setDraftDescription('');
    setDraftHashtags('');
    setDraftNetworkContent({});
    setDraftNetworks([]);
    setDraftFormat('text');
    setDraftUndated(undated);
    setDraftBrandId(calendarBrandId);
    setDraftFileName('');
    setDraftDate(dateTimeInputInZone(date || dateAtOffset(1), getBrandTimezone(calendarBrandId)));
    setShowComposer(true);
  };

  const saveDraft = async (event) => {
    event.preventDefault();
    if (!draftText.trim()) {
      notify('Escribe un texto para guardar el borrador.');
      return;
    }

    const parsedDate = draftUndated ? null : dateFromZonedInput(draftDate, getBrandTimezone(draftBrandId));
    if (!draftUndated && (!parsedDate || Number.isNaN(parsedDate.getTime()))) {
      notify('Selecciona una fecha y hora válidas para esta marca.');
      return;
    }
    const post = {
      id: `draft-${crypto.randomUUID()}`,
      title: draftTitle.trim(),
      description: draftDescription.trim(),
      text: draftText.trim(),
      hashtags: draftHashtags.trim(),
      networkId: draftNetworks[0] || null,
      networkIds: draftNetworks,
      networkContent: Object.fromEntries(draftNetworks.map((networkId) => [
        networkId,
        draftNetworkContent[networkId] || {},
      ])),
      status: 'draft',
      date: parsedDate,
      format: draftFormat,
      brandId: draftBrandId,
    };
    try {
      const saved = await apiRequest(`/data/posts/${encodeURIComponent(post.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ ...post, date: post.date?.toISOString() || null }),
      });
      const savedPost = { ...saved, date: saved.date ? new Date(saved.date) : null };
      const nextPosts = [...posts, savedPost];
      persistedData.current.posts = nextPosts;
      desiredData.current.posts = nextPosts;
      setPosts(nextPosts);
      setShowComposer(false);
      setDraftFileName('');
      notify('Borrador guardado en SQLite. No se envió ni programó en redes.');
    } catch (error) {
      notify(`No se pudo guardar el borrador: ${error.message}`);
    }
  };

  const toggleDraftNetwork = (networkId) => {
    setDraftNetworks((selected) => selected.includes(networkId)
      ? selected.filter((id) => id !== networkId)
      : [...selected, networkId]);
  };

  const moveCalendar = (amount) => {
    const [year, month, day] = dateKeyInZone(calendarDate, calendarTimezoneValue).split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day));
    if (calendarMode === 'day') next.setUTCDate(next.getUTCDate() + amount);
    else if (calendarMode === 'week') next.setUTCDate(next.getUTCDate() + amount * 7);
    else {
      const targetMonth = new Date(Date.UTC(year, month - 1 + amount, 1));
      const lastDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate();
      targetMonth.setUTCDate(Math.min(day, lastDay));
      next.setTime(targetMonth.getTime());
    }
    const zonedDate = dateFromZonedInput(`${next.toISOString().slice(0, 10)}T12:00`, calendarTimezoneValue);
    setCalendarDate(zonedDate);
    setSelectedCalendarDate(zonedDate);
  };

  const selectCalendarDate = (date) => {
    setSelectedCalendarDate(date);
    const selected = dateKeyInZone(date, calendarTimezoneValue).slice(0, 7);
    const visible = dateKeyInZone(calendarDate, calendarTimezoneValue).slice(0, 7);
    if (selected !== visible) {
      setCalendarDate(date);
    }
  };

  const handleProfilePhoto = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setActiveUser((current) => ({ ...current, image: String(reader.result) }));
    reader.readAsDataURL(file);
  };

  const toggleCompact = () => {
    setCompact((current) => !current);
    setShowProfileMenu(false);
  };

  const confirmAccountLink = async () => {
    if (!accountDisplayName.trim() || !activeBrandId) {
      notify('Escribe un nombre y selecciona una marca para organizar la cuenta.');
      return;
    }
    const networkName = getNetwork(selectedNetwork)?.name;
    const name = accountDisplayName.trim();
    const account = {
      id: `account-${Date.now()}`,
      name,
      networkId: selectedNetwork,
      brandId: activeBrandId,
      status: 'demo',
    };
    try {
      const savedAccount = await apiRequest(`/data/accounts/${encodeURIComponent(account.id)}`, {
        method: 'PUT',
        body: JSON.stringify(account),
      });
      const nextAccounts = [...accounts, savedAccount];
      persistedData.current.accounts = nextAccounts;
      desiredData.current.accounts = nextAccounts;
      setAccounts(nextAccounts);
      setAccountSummaryVersion((version) => version + 1);
      setShowAccountPicker(false);
      setSelectedNetwork(null);
      setAccountDisplayName('');
      notify(`${name} se agregó como cuenta de demostración de ${networkName}. No está conectada a la red.`);
    } catch (error) {
      notify(`No se pudo registrar la cuenta: ${error.message}`);
    }
  };

  const openWorkspaceForm = (type, workspace = null) => {
    setWorkspaceError('');
    setWorkspaceName(workspace?.name || '');
    setDialog({ type, workspace });
  };

  const openBrandForm = (type, brand = null) => {
    setWorkspaceError('');
    setBrandName(brand?.name || '');
    setBrandLogoUrl(brand?.logoUrl || '');
    setBrandDescription(brand?.settings?.description || '');
    setBrandWebsite(brand?.settings?.website || '');
    setBrandPrimaryColor(brand?.settings?.primaryColor || '#087fb7');
    setBrandAccentColor(brand?.settings?.accentColor || '#44b9e2');
    setBrandTimezone(brand?.settings?.timezone || 'America/Mexico_City');
    setDialog({ type, brand });
  };

  const applyWorkspaceResponse = async (result, { refresh = false } = {}) => {
    setWorkspaces(result.workspaces);
    if (result.activeWorkspaceId !== initialData.workspaceId || refresh) {
      await onWorkspaceChange(result.activeWorkspaceId, result.workspaces);
    }
  };

  const saveWorkspace = async (event) => {
    event.preventDefault();
    setWorkspaceError('');
    try {
      const isNew = dialog.type === 'workspace-create';
      const result = await apiRequest(
        isNew ? '/workspaces' : `/workspaces/${encodeURIComponent(dialog.workspace.id)}`,
        {
          method: isNew ? 'POST' : 'PATCH',
          body: JSON.stringify({ name: workspaceName.trim() }),
        },
      );
      setWorkspaces(result.workspaces);
      setDialog(null);
      if (isNew) await onWorkspaceChange(result.activeWorkspaceId, result.workspaces);
      else notify('Espacio actualizado.');
    } catch (error) {
      setWorkspaceError(error.message);
    }
  };

  const selectWorkspace = async (workspaceId) => {
    setWorkspaceError('');
    try {
      await apiRequest('/workspaces/active', {
        method: 'PUT',
        body: JSON.stringify({ workspaceId }),
      });
      await onWorkspaceChange(workspaceId, workspaces);
    } catch (error) {
      setWorkspaceError(error.message);
    }
  };

  const deleteWorkspace = async () => {
    setWorkspaceError('');
    try {
      const result = await apiRequest(`/workspaces/${encodeURIComponent(dialog.workspace.id)}`, { method: 'DELETE' });
      setDialog(null);
      await applyWorkspaceResponse(result, { refresh: result.activeWorkspaceId !== initialData.workspaceId });
      notify('Espacio eliminado. Sus cuentas y borradores asociados también se eliminaron.');
    } catch (error) {
      setWorkspaceError(error.message);
    }
  };

  const saveBrand = async (event) => {
    event.preventDefault();
    setWorkspaceError('');
    const body = JSON.stringify({
      name: brandName.trim(),
      logoUrl: brandLogoUrl.trim() || null,
      settings: {
        description: brandDescription.trim(),
        website: brandWebsite.trim(),
        primaryColor: brandPrimaryColor,
        accentColor: brandAccentColor,
        timezone: brandTimezone,
      },
    });
    try {
      const isNew = dialog.type === 'brand-create';
      const brand = await apiRequest(
        isNew
          ? `/workspaces/${encodeURIComponent(initialData.workspaceId)}/brands`
          : `/brands/${encodeURIComponent(dialog.brand.id)}`,
        { method: isNew ? 'POST' : 'PATCH', body },
      );
      setWorkspaces((items) => items.map((item) => item.id === initialData.workspaceId
        ? { ...item, brands: isNew ? [...item.brands, brand] : item.brands.map((existing) => existing.id === brand.id ? brand : existing) }
        : item));
      if (isNew) setActiveBrandId(brand.id);
      setDialog(null);
      notify(isNew ? 'Marca guardada en SQLite.' : 'Marca actualizada.');
    } catch (error) {
      setWorkspaceError(error.message);
    }
  };

  const deleteBrand = async () => {
    setWorkspaceError('');
    try {
      await apiRequest(`/brands/${encodeURIComponent(dialog.brand.id)}`, { method: 'DELETE' });
      const result = await apiRequest('/workspaces');
      setWorkspaces(result.workspaces);
      const nextBrandId = result.workspaces.find((item) => item.id === initialData.workspaceId)?.brands[0]?.id || '';
      setActiveBrandId(nextBrandId);
      setDialog(null);
      await onWorkspaceChange(initialData.workspaceId, result.workspaces);
      notify('Marca eliminada. Las cuentas y los borradores asociados se conservaron en otra marca del espacio.');
    } catch (error) {
      setWorkspaceError(error.message);
    }
  };

  const saveProfile = async (event) => {
    event.preventDefault();
    if (!profileNameInput.trim()) {
      notify('El nombre del perfil no puede quedar vacío.');
      return;
    }
    try {
      const { profile } = await apiRequest('/data/profile', {
        method: 'PUT',
        body: JSON.stringify({ name: profileNameInput.trim() }),
      });
      setActiveUser((current) => ({ ...current, ...profile }));
      setDialog(null);
      notify('Perfil guardado en tu cuenta.');
    } catch (error) {
      notify(`No se guardó el perfil: ${error.message}`);
    }
  };

  const openProfileEditor = () => {
    setProfileNameInput(activeUser?.name || '');
    setDialog({ type: 'profile' });
    setShowProfileMenu(false);
  };

  const openPostEditor = (post) => {
    setEditPostText(post.text);
    setEditPostTitle(post.title || '');
    setEditPostDescription(post.description || '');
    setEditPostHashtags(post.hashtags || '');
    setEditPostNetworkContent(post.networkContent || {});
    setEditPostDate(post.date ? dateTimeInputInZone(post.date, getBrandTimezone(post.brandId)) : '');
    setEditPostNetworks(post.networkIds?.length ? post.networkIds : post.networkId ? [post.networkId] : []);
    setEditPostFormat(post.format || 'text');
    setEditPostUndated(!post.date);
    setDialog({ type: 'edit-post', post });
    setPostMenuId(null);
  };

  const savePostEdit = async (event) => {
    event.preventDefault();
    if (!editPostText.trim() || (!editPostUndated && !editPostDate)) {
      notify('Completa el texto y, si corresponde, la fecha de la publicación.');
      return;
    }
    const post = dialog?.post;
    if (!post) return;
    const parsedDate = editPostUndated ? null : dateFromZonedInput(editPostDate, getBrandTimezone(post.brandId));
    if (!editPostUndated && (!parsedDate || Number.isNaN(parsedDate.getTime()))) {
      notify('Selecciona una fecha y hora válidas para esta marca.');
      return;
    }
    const updated = {
      ...post,
      text: editPostText.trim(),
      title: editPostTitle.trim(),
      description: editPostDescription.trim(),
      hashtags: editPostHashtags.trim(),
      date: parsedDate,
      networkId: editPostNetworks[0] || null,
      networkIds: editPostNetworks,
      networkContent: Object.fromEntries(editPostNetworks.map((networkId) => [
        networkId,
        editPostNetworkContent[networkId] || {},
      ])),
      format: editPostFormat,
    };
    try {
      await savePostImmediately(updated);
      setDialog(null);
      notify('Borrador actualizado en SQLite.');
    } catch (error) {
      notify(`No se pudo actualizar el borrador: ${error.message}`);
    }
  };

  const confirmDeletePost = async () => {
    const post = dialog?.post;
    if (!post) return;
    try {
      await apiRequest(`/data/posts/${encodeURIComponent(post.id)}`, { method: 'DELETE' });
      const nextPosts = posts.filter((item) => item.id !== post.id);
      persistedData.current.posts = nextPosts;
      desiredData.current.posts = nextPosts;
      setPosts(nextPosts);
      setDialog(null);
      notify('Se eliminó el borrador de SQLite.');
    } catch (error) {
      notify(`No se pudo eliminar el borrador: ${error.message}`);
    }
  };

  const confirmDeleteAccount = async () => {
    const account = dialog?.account;
    if (!account) return;
    try {
      if (account.connectionId) {
        await apiRequest(`/connections/${encodeURIComponent(account.connectionId)}`, { method: 'DELETE' });
      } else {
        await apiRequest(`/data/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
      }
      const nextAccounts = accounts.filter((item) => item.id !== account.id);
      persistedData.current.accounts = nextAccounts;
      desiredData.current.accounts = nextAccounts;
      setAccounts(nextAccounts);
      setAccountSummaryVersion((version) => version + 1);
      setDialog(null);
      notify(account.connectionId
        ? `Se eliminaron las credenciales cifradas y la conexión de ${getNetwork(account.connectionNetwork || account.networkId)?.name || 'la red'} de SQLite. Para revocar el permiso en Google o Meta, retira LOP desde la configuración de aplicaciones de esa cuenta.`
        : 'Se retiró la referencia local de demostración.');
    } catch (error) {
      notify(`No se pudo desconectar la cuenta: ${error.message}`);
    }
  };

  const moveConnection = async () => {
    const account = dialog?.account;
    if (!account?.connectionId || !connectionWorkspaceId || !connectionBrandId) return;
    try {
      await apiRequest(`/connections/${encodeURIComponent(account.connectionId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ workspaceId: connectionWorkspaceId, brandId: connectionBrandId }),
      });
      setAccountSummaryVersion((version) => version + 1);
      setDialog(null);
      try {
        const latest = await apiRequest('/data');
        persistedData.current.accounts = latest.accounts;
        desiredData.current.accounts = latest.accounts;
        setAccounts(latest.accounts);
      } catch (error) {
        notify(`La conexión se reasignó, pero no se pudo actualizar la lista: ${error.message}`);
        return;
      }
      notify('Conexión asignada al espacio y marca seleccionados.');
    } catch (error) {
      notify(`No se pudo reasignar la conexión: ${error.message}`);
    }
  };

  const updateFacebookPageAssignment = (pageId, changes) => {
    setFacebookPageAssignments((current) => ({
      ...current,
      [pageId]: { ...current[pageId], ...changes },
    }));
  };

  const confirmFacebookPageSelection = async () => {
    if (dialog?.type !== 'facebook-page-selection' || savingFacebookPages) return;
    const selectedPages = dialog.selection.pages
      .filter((page) => facebookPageAssignments[page.id]?.selected)
      .map((page) => ({
        providerAccountId: page.id,
        workspaceId: facebookPageAssignments[page.id].workspaceId,
        brandId: facebookPageAssignments[page.id].brandId,
      }));
    if (!selectedPages.length) {
      setFacebookPageSelectionError('Selecciona al menos una página para conectar.');
      return;
    }
    if (selectedPages.some((page) => !page.workspaceId || !page.brandId)) {
      setFacebookPageSelectionError('Asigna un espacio y una marca a cada página seleccionada.');
      return;
    }
    setSavingFacebookPages(true);
    setFacebookPageSelectionError('');
    try {
      const result = await apiRequest(
        `/connections/facebook/page-selections/${encodeURIComponent(dialog.selection.id)}`,
        { method: 'POST', body: JSON.stringify({ pages: selectedPages }) },
      );
      setDialog(null);
      setFacebookPageAssignments({});
      setAccountSummaryVersion((version) => version + 1);
      try {
        const latest = await apiRequest('/data');
        persistedData.current.accounts = latest.accounts;
        desiredData.current.accounts = latest.accounts;
        setAccounts(latest.accounts);
      } catch (error) {
        notify(`Facebook guardó ${result.connectedCount} página(s), pero no se pudo actualizar la lista: ${error.message}`);
        return;
      }
      notify(`Se conectaron ${result.connectedCount} página(s) oficiales de Facebook. No se ha publicado contenido.`);
    } catch (error) {
      setFacebookPageSelectionError(`No se pudieron guardar las páginas seleccionadas: ${error.message}`);
    } finally {
      setSavingFacebookPages(false);
    }
  };

  const cancelFacebookPageSelection = async () => {
    if (dialog?.type !== 'facebook-page-selection' || savingFacebookPages) return;
    try {
      await apiRequest(`/connections/facebook/page-selections/${encodeURIComponent(dialog.selection.id)}`, { method: 'DELETE' });
      setDialog(null);
      setFacebookPageAssignments({});
      setFacebookPageSelectionError('');
      notify('Se descartó la selección temporal de páginas; no se conectó ninguna.');
    } catch (error) {
      setFacebookPageSelectionError(`No se pudo descartar la selección temporal: ${error.message}`);
    }
  };

  const updateYouTubeChannelAssignment = (channelId, changes) => {
    setYoutubeChannelAssignments((current) => ({
      ...current,
      [channelId]: { ...current[channelId], ...changes },
    }));
  };

  const confirmYouTubeChannelSelection = async () => {
    if (dialog?.type !== 'youtube-channel-selection' || savingYoutubeChannels) return;
    const selectedChannels = dialog.selection.channels
      .filter((channel) => youtubeChannelAssignments[channel.id]?.selected)
      .map((channel) => ({
        providerChannelId: channel.id,
        workspaceId: youtubeChannelAssignments[channel.id].workspaceId,
        brandId: youtubeChannelAssignments[channel.id].brandId,
      }));
    if (!selectedChannels.length) {
      setYoutubeChannelSelectionError('Selecciona al menos un canal para conectar.');
      return;
    }
    if (selectedChannels.some((channel) => !channel.workspaceId || !channel.brandId)) {
      setYoutubeChannelSelectionError('Asigna un espacio y una marca a cada canal seleccionado.');
      return;
    }
    setSavingYoutubeChannels(true);
    setYoutubeChannelSelectionError('');
    try {
      const result = await apiRequest(
        `/connections/youtube/selections/${encodeURIComponent(dialog.selection.id)}`,
        { method: 'POST', body: JSON.stringify({ channels: selectedChannels }) },
      );
      setDialog(null);
      setYoutubeChannelAssignments({});
      setAccountSummaryVersion((version) => version + 1);
      try {
        const latest = await apiRequest('/data');
        persistedData.current.accounts = latest.accounts;
        desiredData.current.accounts = latest.accounts;
        setAccounts(latest.accounts);
      } catch (error) {
        notify(`YouTube guardó ${result.connectedCount} canal(es), pero no se pudo actualizar la lista: ${error.message}`);
        return;
      }
      notify(`Se conectaron ${result.connectedCount} canal(es) oficiales de YouTube. No se ha publicado contenido.`);
    } catch (error) {
      setYoutubeChannelSelectionError(`No se pudieron guardar los canales seleccionados: ${error.message}`);
    } finally {
      setSavingYoutubeChannels(false);
    }
  };

  const cancelYouTubeChannelSelection = async () => {
    if (dialog?.type !== 'youtube-channel-selection' || savingYoutubeChannels) return;
    try {
      await apiRequest(`/connections/youtube/selections/${encodeURIComponent(dialog.selection.id)}`, { method: 'DELETE' });
      setDialog(null);
      setYoutubeChannelAssignments({});
      setYoutubeChannelSelectionError('');
      notify('Se descartó la selección temporal; no se conectó ningún canal.');
    } catch (error) {
      setYoutubeChannelSelectionError(`No se pudo descartar la selección temporal: ${error.message}`);
    }
  };

  const duplicatePost = async () => {
    const post = dialog?.post;
    if (!post || !copyBrandId) return;
    const copy = {
      ...post,
      id: `draft-${crypto.randomUUID()}`,
      date: post.date ? new Date(post.date) : null,
      status: 'draft',
      brandId: copyBrandId,
    };
    try {
      const saved = await apiRequest(`/data/posts/${encodeURIComponent(copy.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ ...copy, date: copy.date?.toISOString() || null }),
      });
      const nextPosts = [...posts, { ...saved, date: saved.date ? new Date(saved.date) : null }];
      persistedData.current.posts = nextPosts;
      desiredData.current.posts = nextPosts;
      setPosts(nextPosts);
      setDialog(null);
      notify('Se guardó una copia independiente en la marca seleccionada.');
    } catch (error) {
      notify(`No se pudo duplicar el borrador: ${error.message}`);
    }
  };

  const setNetworkDraftContent = (setter, networkId, field, value) => {
    setter((current) => ({
      ...current,
      [networkId]: {
        ...current[networkId],
        ...(field === 'setting'
          ? { settings: { ...current[networkId]?.settings, ...value } }
          : { [field]: value }),
      },
    }));
  };

  const renderNetworkContentFields = (selectedNetworks, content, setter, prefix) => selectedNetworks.map((networkId) => {
    const network = getNetwork(networkId);
    const values = content[networkId] || {};
    return (
      <fieldset className="network-content-fields" key={networkId}>
        <legend><NetworkMark networkId={networkId} /> {network?.name} · contenido opcional personalizado</legend>
        <label className="field-label" htmlFor={`${prefix}-${networkId}-title`}>Título para {network?.name}</label>
        <input id={`${prefix}-${networkId}-title`} maxLength="200" onChange={(event) => setNetworkDraftContent(setter, networkId, 'title', event.target.value)} value={values.title || ''} />
        <label className="field-label" htmlFor={`${prefix}-${networkId}-description`}>Descripción para {network?.name}</label>
        <textarea id={`${prefix}-${networkId}-description`} maxLength="2000" onChange={(event) => setNetworkDraftContent(setter, networkId, 'description', event.target.value)} rows="2" value={values.description || ''} />
        <label className="field-label" htmlFor={`${prefix}-${networkId}-text`}>Texto para {network?.name}</label>
        <textarea id={`${prefix}-${networkId}-text`} maxLength="5000" onChange={(event) => setNetworkDraftContent(setter, networkId, 'text', event.target.value)} rows="3" value={values.text || ''} />
        <label className="field-label" htmlFor={`${prefix}-${networkId}-hashtags`}>Hashtags para {network?.name}</label>
        <input id={`${prefix}-${networkId}-hashtags`} maxLength="1000" onChange={(event) => setNetworkDraftContent(setter, networkId, 'hashtags', event.target.value)} value={values.hashtags || ''} />
        <label className="field-label" htmlFor={`${prefix}-${networkId}-link`}>Enlace para {network?.name}</label>
        <input id={`${prefix}-${networkId}-link`} maxLength="500" onChange={(event) => setNetworkDraftContent(setter, networkId, 'setting', { link: event.target.value })} type="url" value={values.settings?.link || ''} />
        <label className="field-label" htmlFor={`${prefix}-${networkId}-alt`}>Texto alternativo / detalles</label>
        <input id={`${prefix}-${networkId}-alt`} maxLength="500" onChange={(event) => setNetworkDraftContent(setter, networkId, 'setting', { altText: event.target.value })} value={values.settings?.altText || ''} />
        <label className="field-label" htmlFor={`${prefix}-${networkId}-cta`}>Llamada a la acción</label>
        <input id={`${prefix}-${networkId}-cta`} maxLength="500" onChange={(event) => setNetworkDraftContent(setter, networkId, 'setting', { callToAction: event.target.value })} value={values.settings?.callToAction || ''} />
      </fieldset>
    );
  });

  const updateAccount = (accountId, updater) => {
    setAccounts((items) => items.map((account) => account.id === accountId ? updater(account) : account));
  };

  const requestLogout = (switchUser = false) => {
    setShowProfileMenu(false);
    setLogoutError('');
    setDialog({ type: 'logout', switchUser });
  };

  const confirmLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      const pendingSaves = Promise.allSettled([
        queuePersistence('accounts'),
        queuePersistence('posts'),
      ]).then((results) => results.some(
        (result) => result.status !== 'fulfilled' || result.value === false,
      ));
      await onLogout(pendingSaves);
    } catch (error) {
      setLogoutError(`No se pudo invalidar la sesión en el servidor: ${error.message}`);
      setLoggingOut(false);
    }
  };

  const openHelp = () => {
    setShowProfileMenu(false);
    setDialog({ type: 'help' });
  };

  const renderStatus = (status) => {
    const names = {
      published: 'Publicada · API',
      scheduled: 'Programada · API',
      draft: 'Borrador',
      'draft-undated': 'Borrador sin fecha',
      'draft-planned': 'Borrador planificado',
      failed: 'Fallida · API',
    };
    return <span className={`status-pill ${status}`}>{names[status] || status}</span>;
  };

  const renderEmptyState = (icon, title, copy, action) => (
    <div className="empty-state">
      <span className="empty-calendar" aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      <p>{copy}</p>
      {action}
    </div>
  );

  const renderPostCard = (post) => {
    const postNetworkIds = post.networkIds?.length
      ? post.networkIds
      : post.networkId ? [post.networkId] : [];
    return (
      <article
        className="publication-card"
        key={post.id}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', post.id);
          setDraggedPostId(post.id);
        }}
        onDragEnd={() => setDraggedPostId(null)}
      >
        <div className="publication-date">
          <strong>{post.date ? formatInZone(post.date, getBrandTimezone(post.brandId), { day: 'numeric', month: 'short' }) : 'Sin fecha'}</strong>
          <span>{post.date ? formatInZone(post.date, getBrandTimezone(post.brandId), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : 'Borrador'}</span>
        </div>
        <div className="publication-content">
          {post.title && <strong>{post.title}</strong>}
          <p>{post.text}</p>
          {post.description && <p>{post.description}</p>}
          <div className="publication-meta">
            {postNetworkIds.map((networkId) => (
              <span className="network-chip" key={networkId}>
                <NetworkMark networkId={networkId} />
                {getNetwork(networkId)?.name}
              </span>
            ))}
            <span className="sample-label">{post.hashtags}</span>
            <span className="sample-label">Marca: {activeWorkspace?.brands.find((brand) => brand.id === post.brandId)?.name || '—'}</span>
            <span className="sample-label">{formatOptionsByType[post.format] || 'Texto'}</span>
          </div>
        </div>
        {renderStatus(postDraftState(post))}
        <div className="post-menu-wrap">
          <button
            className="icon-button more-button"
            aria-label={`Más opciones para ${post.text}`}
            aria-expanded={postMenuId === post.id}
            onClick={() => { setPostMenuId((current) => current === post.id ? null : post.id); setAccountMenuId(null); setShowProfileMenu(false); }}
            type="button"
          >···</button>
          {postMenuId === post.id && (
            <div className="action-menu" role="menu" aria-label="Acciones de publicación">
              <button className="dropdown-item" onClick={() => { setDialog({ type: 'post-details', post }); setPostMenuId(null); }} role="menuitem" type="button">Ver detalles</button>
              <button className="dropdown-item" onClick={() => openPostEditor(post)} role="menuitem" type="button">Editar</button>
              <button className="dropdown-item" onClick={() => {
                setCopyBrandId(post.brandId);
                setDialog({ type: 'copy-post', post });
                setPostMenuId(null);
              }} role="menuitem" type="button">Duplicar a una marca…</button>
              <button className="dropdown-item destructive-item" onClick={() => { setDialog({ type: 'delete-post', post }); setPostMenuId(null); }} role="menuitem" type="button">Eliminar borrador</button>
            </div>
          )}
        </div>
      </article>
    );
  };

  const renderHome = () => (
    <>
      <section className="welcome-row">
        <div>
          <p className="eyebrow">TU ESPACIO DE TRABAJO</p>
          <h1>¡Hola! Bienvenido a LOP</h1>
          <p className="subtitle">Organiza y prepara el contenido de tus redes desde un solo lugar.</p>
        </div>
      </section>

      <section className="notice" aria-label="Estado del proyecto">
        <span className="notice-icon">i</span>
        <div>
          <strong>Panel de revisión de la fase 1</strong>
          <p>Tu perfil, cuentas y borradores se guardan en SQLite local. Las conexiones oficiales solo aparecen activas tras completar OAuth real.</p>
        </div>
        <button onClick={() => goToPage('Cuentas sociales')} type="button">
          Ver cuentas <span aria-hidden="true">→</span>
        </button>
      </section>

      <section className="stats-grid" aria-label="Resumen de actividad">
        <article className="stat-card">
          <div className="stat-label">Cuentas conectadas <span className="stat-symbol">◎</span></div>
          <strong className="stat-value">{accountSummary.officialConnections}</strong>
          <span className="stat-footnote">Conexiones oficiales verificadas</span>
        </article>
        <article className="stat-card">
          <div className="stat-label">Publicaciones programadas <span className="stat-symbol">◷</span></div>
          <strong className="stat-value">0</strong>
          <span className="stat-footnote">Los borradores no se envían ni programan</span>
        </article>
        <article className="stat-card">
          <div className="stat-label">Publicaciones realizadas <span className="stat-symbol">✓</span></div>
          <strong className="stat-value">0</strong>
          <span className="stat-footnote">No se publica contenido en redes</span>
        </article>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <h2>Tus redes sociales</h2>
            <p>Administra las cuentas conectadas a tu espacio.</p>
          </div>
          <button className="text-button" onClick={() => goToPage('Cuentas sociales')} type="button">
            Administrar cuentas <span aria-hidden="true">→</span>
          </button>
        </div>
        {accounts.filter((account) => account.status === 'connected').length ? (
          <div className="connected-accounts-list">
            {accounts.filter((account) => account.status === 'connected').map((account) => (
              <article className="registered-account" key={account.id}>
                <NetworkMark networkId={account.networkId} />
                <div className="account-description">
                  <strong>{account.name}</strong>
                  <span>{getNetwork(account.networkId)?.name}</span>
                </div>
                <span className="connection-state"><span className="connected-dot" /> Conectada</span>
              </article>
            ))}
          </div>
        ) : (
          <div className="connected-accounts-empty">
            <p>No hay cuentas conectadas. Las cuentas registradas como demostración no se muestran aquí como conexiones reales.</p>
          </div>
        )}
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <h2>Próximas publicaciones</h2>
            <p>Revisa las fechas y el estado de tu contenido.</p>
          </div>
          <button className="text-button" onClick={() => goToPage('Calendario')} type="button">
            Abrir calendario <span aria-hidden="true">→</span>
          </button>
        </div>
        {renderEmptyState('▦', 'No hay publicaciones programadas', 'LOP todavía no envía ni programa publicaciones en redes. Tus borradores permanecen privados en este equipo.', (
            <button className="secondary-button" onClick={() => openComposer()} type="button">Preparar borrador</button>
          ))}
      </section>
    </>
  );

  const renderCalendar = () => {
    const monthLabel = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: calendarTimezoneValue }).format(calendarDate);
    const selectedDateKey = dateKeyInZone(selectedCalendarDate, calendarTimezoneValue);
    const selectedDateNotes = calendarNotes.filter((note) => note.date === selectedDateKey && note.brandId === calendarBrandId);
    const undatedDrafts = filteredCalendarPosts.filter((post) => !post.date);
    return (
      <section className="calendar-view">
        <div className="calendar-toolbar">
          <div>
            <p className="eyebrow">PLANIFICACIÓN DE CONTENIDO</p>
            <h1>Calendario</h1>
          </div>
          <div className="calendar-controls">
            <div className="segmented-control" aria-label="Vista del calendario">
              <button className={calendarMode === 'month' ? 'selected' : ''} onClick={() => setCalendarMode('month')} type="button">Mes</button>
              <button className={calendarMode === 'week' ? 'selected' : ''} onClick={() => setCalendarMode('week')} type="button">Semana</button>
              <button className={calendarMode === 'day' ? 'selected' : ''} onClick={() => setCalendarMode('day')} type="button">Día</button>
            </div>
            <button className="secondary-button today-button" onClick={() => { const now = new Date(); setCalendarDate(now); setSelectedCalendarDate(now); }} type="button">Hoy</button>
            <button className="icon-button calendar-arrow" onClick={() => moveCalendar(-1)} aria-label="Periodo anterior" type="button">‹</button>
            <button className="icon-button calendar-arrow" onClick={() => moveCalendar(1)} aria-label="Periodo siguiente" type="button">›</button>
            <strong className="calendar-month">{monthLabel}</strong>
            <button className="secondary-button" onClick={exportCalendarCsv} type="button">Exportar CSV</button>
          </div>
        </div>
        <div className="calendar-filters" aria-label="Filtros del calendario">
          <label>Marca
            <select value={calendarFilters.brandId} onChange={(event) => setCalendarFilters((current) => ({ ...current, brandId: event.target.value }))}>
              <option value="">Todas las marcas</option>
              {activeWorkspace?.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
            </select>
          </label>
          <label>Red
            <select value={calendarFilters.networkId} onChange={(event) => setCalendarFilters((current) => ({ ...current, networkId: event.target.value }))}>
              <option value="">Todas las redes</option>
              {networks.map((network) => <option key={network.id} value={network.id}>{network.name}</option>)}
            </select>
          </label>
          <label>Estado
            <select value={calendarFilters.status} onChange={(event) => setCalendarFilters((current) => ({ ...current, status: event.target.value }))}>
              <option value="all">Todos</option>
              <option value="draft">Borrador local</option>
            </select>
          </label>
          <label>Formato
            <select value={calendarFilters.format} onChange={(event) => setCalendarFilters((current) => ({ ...current, format: event.target.value }))}>
              <option value="all">Todos los formatos</option>
              {Object.entries(formatOptionsByType).map(([format, label]) => <option key={format} value={format}>{label}</option>)}
            </select>
          </label>
          <span className="timezone-label">Zona horaria: {calendarTimezoneValue}</span>
        </div>
        {calendarMode === 'day' ? (
          <section className="day-schedule" aria-label={`Horario del ${formatInZone(selectedCalendarDate, calendarTimezoneValue, { dateStyle: 'full' })}`}>
            {Array.from({ length: 24 }, (_, hour) => {
              const hourPosts = postsForDate(selectedCalendarDate).filter((post) => Number(zonedParts(post.date, calendarTimezoneValue).hour) === hour);
              return (
                <div
                  className="day-schedule-slot"
                  key={hour}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => handleCalendarDrop(event, selectedCalendarDate, hour)}
                >
                  <time>{`${String(hour).padStart(2, '0')}:00`}</time>
                  <div className="day-schedule-items">
                    {hourPosts.map((post) => (
                      <button className="calendar-post draft" key={post.id} onClick={() => setDialog({ type: 'post-details', post })} type="button">
                        <span>{formatInZone(post.date, calendarTimezoneValue, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} · {post.text}</span>
                        <small>{formatOptionsByType[post.format] || 'Texto'} · borrador local</small>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        ) : (
          <div className={`calendar-grid ${calendarMode}`}>
            {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((day) => (
              <div className="calendar-weekday" key={day}>{day}</div>
            ))}
            {calendarCells.map((date) => {
              const dayPosts = postsForDate(date);
              const isCurrentMonth = dateKeyInZone(date, calendarTimezoneValue).slice(0, 7)
                === dateKeyInZone(calendarDate, calendarTimezoneValue).slice(0, 7);
              const isToday = dateKeyInZone(date, calendarTimezoneValue) === dateKeyInZone(new Date(), calendarTimezoneValue);
              return (
                <div
                  className={`calendar-day ${isCurrentMonth ? '' : 'outside-month'} ${isToday ? 'today' : ''}`}
                  key={date.toISOString()}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => handleCalendarDrop(event, date)}
                >
                  <button className={`day-number ${dateKeyInZone(selectedCalendarDate, calendarTimezoneValue) === dateKeyInZone(date, calendarTimezoneValue) ? 'selected' : ''}`} onClick={() => selectCalendarDate(date)} type="button" aria-label={`Ver publicaciones del ${formatInZone(date, calendarTimezoneValue, { day: 'numeric', month: 'long' })}`} aria-pressed={dateKeyInZone(selectedCalendarDate, calendarTimezoneValue) === dateKeyInZone(date, calendarTimezoneValue)}>
                    {zonedParts(date, calendarTimezoneValue).day}
                  </button>
                  {dayPosts.slice(0, 3).map((post) => (
                    <button className="calendar-post draft" key={post.id} onClick={() => setDialog({ type: 'post-details', post })} title={`Borrador local. ${post.text}`} type="button">
                      {post.networkId && <NetworkMark networkId={post.networkId} />}
                      <span>{formatInZone(post.date, calendarTimezoneValue, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} · {post.text}</span>
                    </button>
                  ))}
                  {dayPosts.length > 3 && <span className="more-day-posts">+{dayPosts.length - 3} más</span>}
                </div>
              );
            })}
          </div>
        )}
        <section className="selected-date-posts" aria-live="polite">
          <div className="section-heading">
            <div>
              <h2>Contenido del {formatInZone(selectedCalendarDate, calendarTimezoneValue, { day: 'numeric', month: 'long', year: 'numeric' })}</h2>
              <p>Las fechas se muestran en la zona horaria de la marca. Los elementos siguen siendo borradores; no se publican en las redes.</p>
            </div>
            <button className="secondary-button" onClick={() => openComposer(selectedCalendarDate)} type="button">Crear borrador con fecha</button>
          </div>
          {postsForDate(selectedCalendarDate).length
            ? <div className="publication-list">{postsForDate(selectedCalendarDate).map(renderPostCard)}</div>
            : <p className="selected-date-empty">No hay borradores para esta fecha.</p>}
        </section>
        <section className="calendar-notes">
          <div className="section-heading">
            <div><h2>Notas y recordatorios</h2><p>Asociados al {selectedDateKey} y a la marca seleccionada.</p></div>
          </div>
          <form className="calendar-note-form" onSubmit={saveCalendarNote}>
            <label>Nota
              <textarea maxLength="2000" onChange={(event) => setCalendarNoteText(event.target.value)} placeholder="Anota una idea o recordatorio…" rows="2" value={calendarNoteText} />
            </label>
            <label>Recordatorio (opcional)
              <input onChange={(event) => setCalendarReminderAt(event.target.value)} type="datetime-local" value={calendarReminderAt} />
            </label>
            <div className="modal-actions">
              {calendarNoteEditingId && <button className="secondary-button" onClick={() => { setCalendarNoteEditingId(null); setCalendarNoteText(''); setCalendarReminderAt(''); }} type="button">Cancelar edición</button>}
              <button className="primary-button" type="submit">{calendarNoteEditingId ? 'Guardar cambios' : 'Guardar nota'}</button>
            </div>
          </form>
          {calendarNoteError && <p className="auth-error" role="alert">{calendarNoteError}</p>}
          {selectedDateNotes.length > 0 && (
            <div className="calendar-note-list">
              {selectedDateNotes.map((note) => (
                <article className="calendar-note" key={note.id}>
                  <p>{note.text}</p>
                  {note.reminderAt && <time>{formatInZone(new Date(note.reminderAt), calendarTimezoneValue, { dateStyle: 'medium', timeStyle: 'short' })} · {calendarTimezoneValue}</time>}
                  <button className="text-button" onClick={() => editCalendarNote(note)} type="button">Editar</button>
                  <button className="text-button destructive-item" onClick={() => deleteCalendarNote(note.id)} type="button">Eliminar</button>
                </article>
              ))}
            </div>
          )}
        </section>
        <section className="undated-drafts">
          <div className="section-heading">
            <div><h2>Borradores sin fecha</h2><p>Arrastra uno a una fecha u horario para asignarlo en el calendario.</p></div>
            <button className="secondary-button" onClick={() => openComposer(null, true)} type="button">Crear sin fecha</button>
          </div>
          {undatedDrafts.length
            ? <div className="publication-list">{undatedDrafts.map(renderPostCard)}</div>
            : <p className="selected-date-empty">No hay borradores sin fecha.</p>}
        </section>
        <div className="calendar-legend">
          <span><i className="legend-dot draft" /> Borrador</span>
          <span className="sample-label">Arrastra borradores al calendario; se guardan inmediatamente en SQLite y no se envían a redes.</span>
        </div>
      </section>
    );
  };

  const renderPublications = () => (
    <section className="publications-view">
      <div className="section-page-heading">
        <div>
          <p className="eyebrow">ADMINISTRA TU CONTENIDO</p>
          <h1>Publicaciones</h1>
          <p className="subtitle">{activeWorkspace?.name} · publicaciones organizadas por marca y red social.</p>
        </div>
      </div>
      <div className="publication-tabs" role="tablist" aria-label="Filtrar publicaciones">
        {statusTabs.map((tab) => {
          const count = tab.id === 'all'
            ? allPosts.length
            : allPosts.filter((post) => postDraftState(post) === tab.id).length;
          return (
          <button
            aria-selected={publicationTab === tab.id}
            className={publicationTab === tab.id ? 'active' : ''}
            key={tab.id}
            onClick={() => setPublicationTab(tab.id)}
            role="tab"
            type="button"
          >
            {tab.label}
            <span>{count}</span>
          </button>
          );
        })}
      </div>
      <div className="calendar-filters publication-filters" aria-label="Filtros de publicaciones">
        <label>Marca
          <select value={publicationFilters.brandId} onChange={(event) => setPublicationFilters((current) => ({ ...current, brandId: event.target.value }))}>
            <option value="">Todas las marcas</option>
            {activeWorkspace?.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
          </select>
        </label>
        <label>Red social
          <select value={publicationFilters.networkId} onChange={(event) => setPublicationFilters((current) => ({ ...current, networkId: event.target.value }))}>
            <option value="">Todas las redes</option>
            {networks.map((network) => <option key={network.id} value={network.id}>{network.name}</option>)}
          </select>
        </label>
        <label>Formato
          <select value={publicationFilters.format} onChange={(event) => setPublicationFilters((current) => ({ ...current, format: event.target.value }))}>
            <option value="all">Todos los formatos</option>
            {Object.entries(formatOptionsByType).map(([format, label]) => <option key={format} value={format}>{label}</option>)}
          </select>
        </label>
        <label>Desde
          <input aria-label="Fecha inicial" type="date" value={publicationFilters.from} onChange={(event) => setPublicationFilters((current) => ({ ...current, from: event.target.value }))} />
        </label>
        <label>Hasta
          <input aria-label="Fecha final" type="date" value={publicationFilters.to} onChange={(event) => setPublicationFilters((current) => ({ ...current, to: event.target.value }))} />
        </label>
        <button className="secondary-button" onClick={() => setPublicationFilters({ brandId: '', networkId: '', format: 'all', from: '', to: '' })} type="button">Limpiar filtros</button>
      </div>
      <p className="modal-notice">Los borradores con fecha son planes locales: no se envían a las redes. Los estados «Programada», «Publicada» y «Fallida» requieren confirmación de la API oficial y todavía no se asignan.</p>
      {publicationFilters.from && publicationFilters.to && publicationFilters.from > publicationFilters.to
        && <p className="auth-error" role="alert">La fecha inicial no puede ser posterior a la fecha final.</p>}
      <div className="list-heading">
        <strong>{statusTabs.find((tab) => tab.id === publicationTab)?.label} · {visiblePosts.length}</strong>
        <span>Espacio: {activeWorkspace?.name} · ordenadas por fecha de la marca</span>
      </div>
      {visiblePosts.length
        ? (
          <div className="publication-groups">
            {visiblePostsByBrand.map(({ brand, posts: brandPosts }) => (
              <section className="publication-group" key={brand.id}>
                <h2>{brand.name} <span>{brandPosts.length}</span></h2>
                <div className="publication-list">{brandPosts.map(renderPostCard)}</div>
              </section>
            ))}
          </div>
        )
        : renderEmptyState('▤', 'No hay borradores en esta pestaña', 'Los borradores que guardes aparecerán aquí. No se envía ni se programa contenido en redes.', (
          <button className="secondary-button" onClick={() => openComposer()} type="button">Crear borrador</button>
        ))}
    </section>
  );

  const renderAccounts = () => (
    <section className="accounts-view">
      <div className="section-page-heading">
        <div>
          <p className="eyebrow">CANALES DE PUBLICACIÓN</p>
          <h1>Cuentas sociales</h1>
          <p className="subtitle">Registra varias cuentas por red y administra sus conexiones desde aquí.</p>
        </div>
        <button className="primary-button" disabled={!activeBrandId} onClick={() => setShowAccountPicker(true)} type="button">
          <span aria-hidden="true">＋</span> Agregar cuenta
        </button>
      </div>
      <div className="account-summary">
        <label htmlFor="accounts-brand-filter">Marca</label>
        <select id="accounts-brand-filter" value={activeBrandId} onChange={(event) => setActiveBrandId(event.target.value)}>
          {activeWorkspace?.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
        </select>
        <strong>{accountSummary.registeredAccounts} {accountSummary.registeredAccounts === 1 ? 'cuenta registrada' : 'cuentas registradas'}</strong>
        <strong>{accountSummary.officialConnections} {accountSummary.officialConnections === 1 ? 'conexión oficial' : 'conexiones oficiales'}</strong>
        <span>Las referencias locales no están conectadas. Las conexiones oficiales muestran sus permisos reales.</span>
      </div>
      <div className="multi-account-note">
        <span className="notice-icon">i</span>
        <p>Conecta páginas oficiales de Facebook mediante Meta OAuth o canales oficiales de YouTube mediante Google OAuth. Elige a qué espacio y marca asignarlos; conectar no publica contenido.</p>
        {facebookConnectionAvailable
          ? <a className="primary-button" href={`/api/connections/facebook/authorize?brandId=${encodeURIComponent(activeBrandId)}`}>Conectar Facebook</a>
          : <span>Facebook requiere configuración de Meta y clave de cifrado.</span>}
        {youtubeConnectionAvailable
          ? <a className="primary-button" href={`/api/connections/youtube/authorize?brandId=${encodeURIComponent(activeBrandId)}`}>Conectar YouTube</a>
          : <span>YouTube requiere OAuth de Google y clave de cifrado.</span>}
      </div>
      {!facebookConnectionAvailable && facebookConnectionMissing.length > 0 && (
        <p className="auth-error" role="status">Configuración local pendiente: {facebookConnectionMissing.join(', ')}. Los secretos se configuran en `.env`, no en el navegador.</p>
      )}
      {!youtubeConnectionAvailable && youtubeConnectionMissing.length > 0 && (
        <p className="auth-error" role="status">Configuración local pendiente para YouTube: {youtubeConnectionMissing.join(', ')}. Los secretos se configuran en `.env`, no en el navegador.</p>
      )}
      {brandAccounts.length ? (
        <div className="registered-accounts">
          {brandAccounts.map((account) => (
            <article className="registered-account" key={account.id}>
              <NetworkMark networkId={account.networkId} />
              <div className="account-description">
                <strong>{account.name}</strong>
                <span>{getNetwork(account.networkId)?.name}</span>
              </div>
              <span className="connection-state">
                <span className={account.status === 'connected' ? 'connected-dot' : ''} />
                {account.status === 'connected'
                  ? 'Conectada oficialmente'
                  : account.status === 'expired' ? 'Token vencido · reconectar' : 'Sin conectar · referencia local'}
              </span>
              {account.status === 'connected' && (
                <span className="sample-label">Permisos: {account.grantedScopes?.join(', ') || 'verificados por el proveedor'}</span>
              )}
              <div className="account-menu-wrap">
                <button
                  className="icon-button"
                  aria-label={`Opciones de ${account.name}`}
                  aria-expanded={accountMenuId === account.id}
                  onClick={() => { setAccountMenuId((current) => current === account.id ? null : account.id); setPostMenuId(null); setShowProfileMenu(false); }}
                  type="button"
                >···</button>
                {accountMenuId === account.id && (
                  <div className="action-menu" role="menu" aria-label={`Acciones para ${account.name}`}>
                    <button className="dropdown-item" onClick={() => { setDialog({ type: 'account-details', account }); setAccountMenuId(null); }} role="menuitem" type="button">Ver detalles</button>
                    {account.connectionId && <button className="dropdown-item" onClick={() => {
                      setConnectionWorkspaceId(account.workspaceId || initialData.workspaceId);
                      setConnectionBrandId(account.brandId || '');
                      setDialog({ type: 'move-connection', account });
                      setAccountMenuId(null);
                    }} role="menuitem" type="button">Asignar espacio y marca…</button>}
                    {!account.connectionId && <button className="dropdown-item" onClick={() => { setAccountPreferenceEnabled(account.preferenceEnabled !== false); setDialog({ type: 'account-manage', account }); setAccountMenuId(null); }} role="menuitem" type="button">Administrar</button>}
                    {!account.connectionId && <button className="dropdown-item" onClick={() => { setEditAccountName(account.name); setDialog({ type: 'edit-account', account }); setAccountMenuId(null); }} role="menuitem" type="button">Editar nombre</button>}
                    <button className="dropdown-item destructive-item" onClick={() => { setDialog({ type: 'delete-account', account }); setAccountMenuId(null); }} role="menuitem" type="button">{account.connectionId ? `Desconectar ${getNetwork(account.connectionNetwork || account.networkId)?.name || 'cuenta'}` : 'Retirar referencia demo'}</button>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        renderEmptyState('◎', 'Todavía no hay cuentas registradas', 'Conecta páginas oficiales de Facebook o canales de YouTube, o agrega una referencia local que no se presentará como conectada.', (
          <button className="primary-button" onClick={() => setShowAccountPicker(true)} type="button">
            <span aria-hidden="true">＋</span> Agregar referencia demo
          </button>
        ))
      )}
      <div className="multi-account-note">
        <span className="notice-icon">i</span>
        <p>Las conexiones oficiales de Facebook y YouTube se guardan en SQLite con tokens cifrados. «Agregar referencia demo» solo registra un elemento local y no inicia autorización en redes.</p>
      </div>
    </section>
  );

  const renderWorkspaces = () => (
    <section className="workspace-management">
      <div className="section-page-heading">
        <div>
          <p className="eyebrow">ORGANIZACIÓN DE TU CUENTA</p>
          <h1>Espacios y marcas</h1>
          <p className="subtitle">Cada espacio mantiene sus borradores, marcas y cuentas separados.</p>
        </div>
        <button className="primary-button" onClick={() => openWorkspaceForm('workspace-create')} type="button">
          <span aria-hidden="true">＋</span> Crear espacio
        </button>
      </div>
      {workspaceError && <p className="auth-error" role="alert">{workspaceError}</p>}
      <div className="workspace-management-grid">
        <section className="workspace-list-card">
          <div className="section-heading">
            <div><h2>Espacios de trabajo</h2><p>Selecciona uno para cambiar el contexto de la aplicación.</p></div>
          </div>
          <div className="managed-workspace-list">
            {workspaces.map((item) => (
              <article className={`managed-workspace ${item.id === initialData.workspaceId ? 'selected' : ''}`} key={item.id}>
                <span className="workspace-avatar">{item.name.charAt(0).toUpperCase()}</span>
                <span className="managed-workspace-copy"><strong>{item.name}</strong><small>{item.brands.length} {item.brands.length === 1 ? 'marca' : 'marcas'}</small></span>
                {item.id === initialData.workspaceId
                  ? <span className="workspace-active-label">Activo</span>
                  : <button className="secondary-button" onClick={() => selectWorkspace(item.id)} type="button">Seleccionar</button>}
                <button className="icon-button" aria-label={`Editar espacio ${item.name}`} onClick={() => openWorkspaceForm('workspace-edit', item)} type="button">✎</button>
                <button className="icon-button destructive-item" aria-label={`Eliminar espacio ${item.name}`} onClick={() => { setWorkspaceError(''); setDialog({ type: 'workspace-delete', workspace: item }); }} type="button">×</button>
              </article>
            ))}
          </div>
        </section>
        <section className="brand-management-card">
          <div className="section-heading">
            <div><h2>Marcas de {activeWorkspace?.name}</h2><p>Logotipo por URL HTTPS y configuración visual propia.</p></div>
            <button className="secondary-button" onClick={() => openBrandForm('brand-create')} type="button">＋ Agregar marca</button>
          </div>
          <div className="managed-brand-list">
            {activeWorkspace?.brands.map((brand) => (
              <article className="managed-brand" key={brand.id}>
                {brand.logoUrl
                  ? <img src={brand.logoUrl} alt={`Logotipo de ${brand.name}`} referrerPolicy="no-referrer" />
                  : <span className="brand-logo-placeholder">{brand.name.charAt(0).toUpperCase()}</span>}
                <div className="managed-brand-copy">
                  <strong>{brand.name}</strong>
                  <small>{brand.settings.description || 'Sin descripción'}</small>
                  {brand.settings.website && <a href={brand.settings.website} target="_blank" rel="noreferrer">{brand.settings.website}</a>}
                </div>
                <span className="brand-color-swatch" style={{ background: brand.settings.primaryColor }} aria-label={`Color principal ${brand.settings.primaryColor}`} />
                <button className="icon-button" aria-label={`Editar marca ${brand.name}`} onClick={() => openBrandForm('brand-edit', brand)} type="button">✎</button>
                <button className="icon-button destructive-item" aria-label={`Eliminar marca ${brand.name}`} onClick={() => { setWorkspaceError(''); setDialog({ type: 'brand-delete', brand }); }} type="button">×</button>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );

  const screenContent = {
    Inicio: renderHome,
    Calendario: renderCalendar,
    Publicaciones: renderPublications,
    'Cuentas sociales': renderAccounts,
    'Espacios y marcas': renderWorkspaces,
  }[activePage]?.();

  return (
    <div className={`app-shell ${theme === 'dark' ? 'dark-mode' : ''} ${compact ? 'compact-mode' : ''}`}>
      <aside className="sidebar">
        <button className="brand" onClick={() => goToPage('Inicio')} type="button" aria-label="Ir al inicio de LOP Planificador">
          <span className="brand-mark">L</span>
          <span className="brand-copy">
            <strong>LOP</strong>
            <small>PLANIFICADOR</small>
          </span>
        </button>

        <button className="workspace-switcher" onClick={() => goToPage('Espacios y marcas')} type="button">
          <span className="workspace-avatar">{activeWorkspace?.name.charAt(0).toUpperCase() || 'L'}</span>
          <span className="workspace-copy">
            <strong>{activeWorkspace?.name || 'Mi espacio'}</strong>
            <small>{activeWorkspace?.brands.length || 0} marcas</small>
          </span>
          <span className="chevron" aria-hidden="true">⌄</span>
        </button>

        <p className="nav-caption">MENÚ PRINCIPAL</p>
        <nav className="main-nav" aria-label="Navegación principal">
          {navigation.map((item) => (
            <button
              className={`nav-item ${activePage === item.id ? 'active' : ''}`}
              key={item.id}
              onClick={() => goToPage(item.id)}
              type="button"
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              {item.id}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-icon">?</span>
            <strong>¿Necesitas ayuda?</strong>
            <p>Consulta las novedades de LOP y el estado de la fase inicial.</p>
            <button className="help-link" onClick={openHelp} type="button">Centro de ayuda <span>→</span></button>
          </div>
          <div className="sidebar-user">
            {activeUser?.image ? <img src={activeUser.image} alt="" /> : <span className="profile-avatar">{activeUser?.name?.charAt(0).toUpperCase() || 'U'}</span>}
            <span className="workspace-copy">
              <strong>{activeUser?.name}</strong>
              <small>{activeUser?.email}</small>
            </span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <button onClick={() => goToPage('Inicio')} type="button">Mi espacio</button>
            <span>/</span>
            <strong>{activePage}</strong>
          </div>
          <div className="topbar-right">
            <span className="topbar-date">{todayLabel}</span>
            <button className="primary-button topbar-new-button" onClick={() => openComposer()} type="button">
              <span aria-hidden="true">＋</span> Nueva publicación
            </button>
            <div className="profile-menu-wrap">
              <button
                className="avatar-small"
                aria-label="Abrir menú de perfil"
                aria-expanded={showProfileMenu}
                onClick={() => setShowProfileMenu((open) => !open)}
                type="button"
              >
                {activeUser?.image ? <img src={activeUser.image} alt="" /> : <span>{activeUser?.name?.charAt(0).toUpperCase() || 'U'}</span>}
              </button>
              {showProfileMenu && (
                <div className="profile-dropdown">
                  <div className="profile-dropdown-header">
                    {activeUser?.image ? <img src={activeUser.image} alt="" /> : <span className="profile-avatar">{activeUser?.name?.charAt(0).toUpperCase() || 'U'}</span>}
                    <div><strong>{activeUser?.name}</strong><small>{activeUser?.email}</small></div>
                  </div>
                  <button className="dropdown-item" onClick={openProfileEditor} type="button"><span>◉</span> Mi perfil</button>
                  <button className="dropdown-item" onClick={() => { setShowSettings(true); setShowProfileMenu(false); }} type="button"><span>⚙</span> Configuración</button>
                  {googleEnabled && <button className="dropdown-item" onClick={() => { window.location.assign('/api/auth/google/link'); }} type="button"><span>G</span> Vincular Google</button>}
                  <button className="dropdown-item" onClick={() => requestLogout(true)} type="button"><span>⇄</span> Cambiar usuario</button>
                  <button className="dropdown-item" onClick={openHelp} type="button"><span>?</span> Ayuda</button>
                  <div className="dropdown-divider" />
                  <p className="dropdown-caption">APARIENCIA</p>
                  <div className="appearance-options">
                    <button className={theme === 'light' ? 'selected' : ''} onClick={() => setTheme('light')} type="button">Claro</button>
                    <button className={theme === 'dark' ? 'selected' : ''} onClick={() => setTheme('dark')} type="button">Oscuro</button>
                    <button className={compact ? 'selected' : ''} onClick={toggleCompact} type="button" aria-pressed={compact}>Compacto</button>
                  </div>
                  <div className="dropdown-divider" />
                  <button className="dropdown-item logout-item" onClick={() => requestLogout()} type="button"><span>↪</span> Cerrar sesión</button>
                </div>
              )}
            </div>
          </div>
        </header>

        {notification && (
          <div className="toast-message" role="status">
            <span>{notification}</span>
            <button aria-label="Cerrar aviso" onClick={() => setNotification('')} type="button">×</button>
          </div>
        )}

        <div className="page-content">{screenContent}</div>
      </main>

      {showComposer && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowComposer(false);
        }}>
          <form className="composer-modal" onSubmit={saveDraft}>
            <div className="modal-heading">
              <div><p className="eyebrow">BORRADOR LOCAL</p><h2>Nueva publicación</h2></div>
              <button className="close-button" onClick={() => setShowComposer(false)} type="button" aria-label="Cerrar">×</button>
            </div>
            <p className="modal-notice">Guardar conserva el borrador en tu cuenta local. No se envía ni programa en redes; los archivos multimedia no se almacenan.</p>
            <label className="field-label" htmlFor="post-title">Título (opcional)</label>
            <input id="post-title" maxLength="200" onChange={(event) => setDraftTitle(event.target.value)} value={draftTitle} />
            <label className="field-label" htmlFor="post-description">Descripción (opcional)</label>
            <textarea id="post-description" maxLength="2000" onChange={(event) => setDraftDescription(event.target.value)} rows="2" value={draftDescription} />
            <label className="field-label" htmlFor="post-text">Texto de la publicación</label>
            <textarea id="post-text" maxLength="5000" onChange={(event) => setDraftText(event.target.value)} placeholder="¿Qué quieres compartir?" rows="4" value={draftText} />
            <label className="field-label" htmlFor="post-hashtags">Hashtags (opcional)</label>
            <input id="post-hashtags" maxLength="1000" onChange={(event) => setDraftHashtags(event.target.value)} placeholder="#idea #marca" value={draftHashtags} />
            <label className="field-label" htmlFor="post-media">Imagen o vídeo (solo selección local, no se carga)</label>
            <input id="post-media" onChange={(event) => setDraftFileName(event.target.files?.[0]?.name || '')} type="file" accept="image/*,video/*" />
            {draftFileName && <span className="file-name">{draftFileName} · archivo local</span>}
            <label className="field-label" htmlFor="draft-brand">Marca</label>
            <select id="draft-brand" onChange={(event) => setDraftBrandId(event.target.value)} value={draftBrandId}>
              {activeWorkspace?.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
            </select>
            <label className="field-label" htmlFor="draft-format">Formato</label>
            <select id="draft-format" onChange={(event) => setDraftFormat(event.target.value)} value={draftFormat}>
              {Object.entries(formatOptionsByType).map(([format, label]) => <option key={format} value={format}>{label}</option>)}
            </select>
            <label className="calendar-undated-toggle"><input checked={draftUndated} onChange={(event) => setDraftUndated(event.target.checked)} type="checkbox" /> Guardar como borrador sin fecha</label>
            <label className="field-label" htmlFor="post-date">Fecha y hora ({getBrandTimezone(draftBrandId)})</label>
            <input disabled={draftUndated} id="post-date" onChange={(event) => setDraftDate(event.target.value)} type="datetime-local" value={draftDate} />
            <fieldset className="network-selection">
              <legend>Redes sociales</legend>
              <div>
                {networks.map((network) => (
                  <label className="network-checkbox" key={network.id}>
                    <input checked={draftNetworks.includes(network.id)} onChange={() => toggleDraftNetwork(network.id)} type="checkbox" />
                    <NetworkMark networkId={network.id} />
                    {network.name}
                  </label>
                ))}
              </div>
            </fieldset>
            {renderNetworkContentFields(draftNetworks, draftNetworkContent, setDraftNetworkContent, 'new-network')}
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setShowComposer(false)} type="button">Cancelar</button>
              <button className="primary-button" type="submit">Guardar borrador</button>
            </div>
          </form>
        </div>
      )}

      {showAccountPicker && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) { setShowAccountPicker(false); setSelectedNetwork(null); }
        }}>
          <section className="composer-modal account-modal" aria-labelledby="account-modal-title" aria-modal="true" role="dialog">
            <div className="modal-heading">
            <div><p className="eyebrow">CUENTAS SOCIALES</p><h2 id="account-modal-title">{selectedNetwork ? `Registrar ${getNetwork(selectedNetwork)?.name}` : 'Agregar cuenta'}</h2></div>
              <button className="close-button" onClick={() => { setShowAccountPicker(false); setSelectedNetwork(null); }} type="button" aria-label="Cerrar">×</button>
            </div>
            {!selectedNetwork ? (
              <>
                <p className="modal-description">Selecciona una red para guardar una referencia local en la marca «{activeBrand?.name}». No se conectará ninguna cuenta.</p>
                <div className="network-picker">
                  {networks.map((network) => (
                    <button className="network-picker-option" key={network.id} onClick={() => setSelectedNetwork(network.id)} type="button">
                      <NetworkMark networkId={network.id} />
                      <span>{network.name}</span>
                      <span className="picker-arrow">›</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="modal-notice"><strong>Cuenta de referencia local</strong><br />No se conectará a la red ni permitirá publicar. La vinculación oficial todavía no está habilitada.</div>
                  <div className="authorization-steps">
                    <strong>Procedimiento previsto de autorización</strong>
                    <ol>
                      <li>La aplicación oficial solicitará autorización en el sitio de {getNetwork(selectedNetwork)?.name}.</li>
                      <li>La persona revisará y aceptará los permisos solicitados.</li>
                      <li>La red devolverá el acceso autorizado y la cuenta aparecerá en LOP.</li>
                    </ol>
                    <span>Esta sección solo organiza referencias locales; no solicita credenciales ni concede acceso.</span>
                  </div>
                  <div className="selected-network-card"><NetworkMark networkId={selectedNetwork} /><strong>{getNetwork(selectedNetwork)?.name}</strong><span>Marca: {activeBrand?.name} · sin autorización</span></div>
                  <label className="field-label" htmlFor="account-display-name">Nombre para identificar la cuenta</label>
                  <input id="account-display-name" onChange={(event) => setAccountDisplayName(event.target.value)} placeholder="Ej.: Mi página de negocio" value={accountDisplayName} />
                  <div className="modal-actions">
                    <button className="secondary-button" onClick={() => setSelectedNetwork(null)} type="button">Elegir otra red</button>
                    <button className="primary-button" onClick={confirmAccountLink} type="button">Guardar referencia local</button>
                  </div>
              </>
            )}
          </section>
        </div>
      )}

      {showSettings && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowSettings(false);
        }}>
          <section className="composer-modal settings-modal" aria-labelledby="settings-title" aria-modal="true" role="dialog">
            <div className="modal-heading">
              <div><p className="eyebrow">PREFERENCIAS</p><h2 id="settings-title">Configuración</h2></div>
              <button className="close-button" onClick={() => setShowSettings(false)} type="button" aria-label="Cerrar">×</button>
            </div>
            <div className="settings-row"><div><strong>Apariencia</strong><span>Elige cómo se muestra LOP.</span></div><div className="appearance-options"><button className={theme === 'light' ? 'selected' : ''} onClick={() => setTheme('light')} type="button">Claro</button><button className={theme === 'dark' ? 'selected' : ''} onClick={() => setTheme('dark')} type="button">Oscuro</button></div></div>
            <div className="settings-row"><div><strong>Vista compacta</strong><span>Reduce espacios entre elementos.</span></div><button className={`toggle-switch ${compact ? 'on' : ''}`} aria-pressed={compact} onClick={toggleCompact} type="button"><span /></button></div>
            <div className="settings-row"><div><strong>Notificaciones visuales</strong><span>Mostrar avisos de acciones locales.</span></div><button className={`toggle-switch ${notificationsEnabled ? 'on' : ''}`} aria-pressed={notificationsEnabled} onClick={() => setNotificationsEnabled((enabled) => !enabled)} type="button"><span /></button></div>
            <div className="modal-actions"><button className="primary-button" onClick={() => setShowSettings(false)} type="button">Listo</button></div>
          </section>
        </div>
      )}

      {dialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDialog(null);
        }}>
          {dialog.type === 'profile' && (
            <form className="composer-modal settings-modal" onSubmit={saveProfile} aria-labelledby="profile-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">MI CUENTA</p><h2 id="profile-title">Mi perfil</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <div className="profile-edit-header">
                {activeUser?.image ? <img src={activeUser.image} alt="Foto de perfil actual" /> : <span className="profile-avatar">{activeUser?.name?.charAt(0).toUpperCase() || 'U'}</span>}
                <label className="secondary-button photo-setting">Elegir fotografía<input accept="image/*" onChange={handleProfilePhoto} type="file" /></label>
                <span>La foto de Google se guarda en tu perfil; las fotos elegidas aquí son temporales.</span>
              </div>
              <label className="field-label" htmlFor="profile-name">Nombre</label>
              <input id="profile-name" onChange={(event) => setProfileNameInput(event.target.value)} value={profileNameInput} required />
              <span className="field-label">Correo verificado</span>
              <p className="profile-email-value">{activeUser?.email}</p>
              <div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)} type="button">Cancelar</button><button className="primary-button" type="submit">Guardar perfil</button></div>
            </form>
          )}

          {(dialog.type === 'workspace-create' || dialog.type === 'workspace-edit') && (
            <form className="composer-modal settings-modal" onSubmit={saveWorkspace} aria-labelledby="workspace-form-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">ESPACIOS DE TRABAJO</p><h2 id="workspace-form-title">{dialog.type === 'workspace-create' ? 'Crear espacio' : 'Editar espacio'}</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <label className="field-label" htmlFor="workspace-name">Nombre del espacio</label>
              <input id="workspace-name" maxLength="100" onChange={(event) => setWorkspaceName(event.target.value)} required value={workspaceName} />
              {workspaceError && <p className="auth-error" role="alert">{workspaceError}</p>}
              <div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)} type="button">Cancelar</button><button className="primary-button" type="submit">Guardar</button></div>
            </form>
          )}

          {dialog.type === 'workspace-delete' && (
            <section className="composer-modal settings-modal" aria-labelledby="workspace-delete-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">CONFIRMACIÓN</p><h2 id="workspace-delete-title">Eliminar espacio</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <p className="modal-description">¿Eliminar «{dialog.workspace.name}»? Sus marcas, cuentas y borradores se eliminarán de SQLite. Esta acción no se puede deshacer.</p>
              {workspaceError && <p className="auth-error" role="alert">{workspaceError}</p>}
              <div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)} type="button">Cancelar</button><button className="danger-button" onClick={deleteWorkspace} type="button">Eliminar espacio</button></div>
            </section>
          )}

          {(dialog.type === 'brand-create' || dialog.type === 'brand-edit') && (
            <form className="composer-modal settings-modal" onSubmit={saveBrand} aria-labelledby="brand-form-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">MARCAS · {activeWorkspace?.name}</p><h2 id="brand-form-title">{dialog.type === 'brand-create' ? 'Agregar marca' : 'Editar marca'}</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <label className="field-label" htmlFor="brand-name">Nombre</label>
              <input id="brand-name" maxLength="100" onChange={(event) => setBrandName(event.target.value)} required value={brandName} />
              <label className="field-label" htmlFor="brand-logo-url">Logotipo (URL HTTPS)</label>
              <input id="brand-logo-url" maxLength="2048" onChange={(event) => setBrandLogoUrl(event.target.value)} placeholder="https://ejemplo.com/logo.png" type="url" value={brandLogoUrl} />
              <p className="modal-notice">El logotipo se carga desde su URL; LOP no sube ni almacena archivos de imagen.</p>
              <label className="field-label" htmlFor="brand-description">Descripción</label>
              <textarea id="brand-description" maxLength="500" onChange={(event) => setBrandDescription(event.target.value)} rows="2" value={brandDescription} />
              <label className="field-label" htmlFor="brand-website">Sitio web (HTTPS)</label>
              <input id="brand-website" maxLength="2048" onChange={(event) => setBrandWebsite(event.target.value)} placeholder="https://ejemplo.com" type="url" value={brandWebsite} />
              <label className="field-label" htmlFor="brand-timezone">Zona horaria de la marca</label>
              <select id="brand-timezone" onChange={(event) => setBrandTimezone(event.target.value)} value={brandTimezone}>
                {timezoneOptions.map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}
                {!timezoneOptions.includes(brandTimezone) && <option value={brandTimezone}>{brandTimezone}</option>}
              </select>
              <div className="brand-color-fields">
                <label className="field-label" htmlFor="brand-primary-color">Color principal<input id="brand-primary-color" onChange={(event) => setBrandPrimaryColor(event.target.value)} type="color" value={brandPrimaryColor} /></label>
                <label className="field-label" htmlFor="brand-accent-color">Color de acento<input id="brand-accent-color" onChange={(event) => setBrandAccentColor(event.target.value)} type="color" value={brandAccentColor} /></label>
              </div>
              {workspaceError && <p className="auth-error" role="alert">{workspaceError}</p>}
              <div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)} type="button">Cancelar</button><button className="primary-button" type="submit">Guardar marca</button></div>
            </form>
          )}

          {dialog.type === 'brand-delete' && (
            <section className="composer-modal settings-modal" aria-labelledby="brand-delete-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">CONFIRMACIÓN</p><h2 id="brand-delete-title">Eliminar marca</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <p className="modal-description">¿Eliminar «{dialog.brand.name}»? Sus cuentas y borradores se conservarán y se moverán a otra marca del espacio.</p>
              {workspaceError && <p className="auth-error" role="alert">{workspaceError}</p>}
              <div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)} type="button">Cancelar</button><button className="danger-button" onClick={deleteBrand} type="button">Eliminar marca</button></div>
            </section>
          )}

          {dialog.type === 'help' && (
            <section className="composer-modal settings-modal" aria-labelledby="help-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">AYUDA</p><h2 id="help-title">Uso de la demostración</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <div className="help-content">
                <p><strong>Navegación:</strong> Inicio resume el espacio; Calendario permite organizar fechas; Publicaciones filtra borradores por marca, red, estado, formato y fechas, y Cuentas sociales administra referencias de cuentas.</p>
                <p><strong>Datos locales:</strong> perfil, cuentas y borradores se guardan en una base de datos SQLite de este equipo.</p>
                <p><strong>Redes sociales:</strong> no se solicitan credenciales de redes ni se inicia OAuth social. Las conexiones y publicaciones permanecen desactivadas.</p>
                <p>Para asistencia del proyecto, revisa los documentos de la fase 1 antes de habilitar integraciones.</p>
              </div>
              <div className="modal-actions"><button className="primary-button" onClick={() => setDialog(null)} type="button">Entendido</button></div>
            </section>
          )}

          {dialog.type === 'post-details' && (
            <section className="composer-modal settings-modal" aria-labelledby="post-details-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">REGISTRO DE DEMOSTRACIÓN</p><h2 id="post-details-title">Detalles de publicación</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <div className="detail-list">
                {dialog.post.title && <div><strong>Título</strong><span>{dialog.post.title}</span></div>}
                <div><strong>Texto</strong><span>{dialog.post.text}</span></div>
                {dialog.post.description && <div><strong>Descripción</strong><span>{dialog.post.description}</span></div>}
                {dialog.post.hashtags && <div><strong>Hashtags</strong><span>{dialog.post.hashtags}</span></div>}
                <div><strong>Estado local</strong><span>{renderStatus(postDraftState(dialog.post))} · no publicado en la red</span></div>
                <div><strong>Fecha y hora</strong><span>{dialog.post.date
                  ? formatInZone(dialog.post.date, getBrandTimezone(dialog.post.brandId), { dateStyle: 'full', timeStyle: 'short' })
                  : 'Sin fecha · borrador disponible para el calendario'}</span></div>
                <div><strong>Redes seleccionadas</strong><span>{(dialog.post.networkIds?.length ? dialog.post.networkIds : dialog.post.networkId ? [dialog.post.networkId] : []).map((id) => getNetwork(id)?.name).join(', ') || 'Ninguna'}</span></div>
                {(dialog.post.networkIds || []).filter((id) => dialog.post.networkContent?.[id]).map((id) => (
                  <div key={id}><strong>Personalización · {getNetwork(id)?.name}</strong><span>{dialog.post.networkContent[id].text || dialog.post.networkContent[id].description || 'Configuración específica guardada'}</span></div>
                ))}
                <div><strong>Origen</strong><span>Borrador guardado en tu espacio local</span></div>
              </div>
              <div className="modal-actions"><button className="primary-button" onClick={() => setDialog(null)} type="button">Cerrar</button></div>
            </section>
          )}

          {dialog.type === 'edit-post' && (
            <form className="composer-modal" onSubmit={savePostEdit} aria-labelledby="edit-post-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">BORRADOR LOCAL</p><h2 id="edit-post-title">Editar borrador</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <label className="field-label" htmlFor="edit-post-title-input">Título (opcional)</label>
              <input id="edit-post-title-input" maxLength="200" onChange={(event) => setEditPostTitle(event.target.value)} value={editPostTitle} />
              <label className="field-label" htmlFor="edit-post-description">Descripción (opcional)</label>
              <textarea id="edit-post-description" maxLength="2000" onChange={(event) => setEditPostDescription(event.target.value)} rows="2" value={editPostDescription} />
              <label className="field-label" htmlFor="edit-post-text">Texto</label>
              <textarea id="edit-post-text" maxLength="5000" onChange={(event) => setEditPostText(event.target.value)} rows="4" value={editPostText} />
              <label className="field-label" htmlFor="edit-post-hashtags">Hashtags</label>
              <input id="edit-post-hashtags" maxLength="1000" onChange={(event) => setEditPostHashtags(event.target.value)} value={editPostHashtags} />
              <label className="calendar-undated-toggle"><input checked={editPostUndated} onChange={(event) => setEditPostUndated(event.target.checked)} type="checkbox" /> Mantener como borrador sin fecha</label>
              <label className="field-label" htmlFor="edit-post-date">Fecha y hora ({getBrandTimezone(dialog.post.brandId)})</label>
              <input disabled={editPostUndated} id="edit-post-date" onChange={(event) => setEditPostDate(event.target.value)} type="datetime-local" value={editPostDate} />
              <fieldset className="network-selection">
                <legend>Redes sociales</legend>
                <div>{networks.map((network) => (
                  <label className="network-checkbox" key={network.id}>
                    <input checked={editPostNetworks.includes(network.id)} onChange={() => setEditPostNetworks((selected) => selected.includes(network.id)
                      ? selected.filter((id) => id !== network.id)
                      : [...selected, network.id])} type="checkbox" />
                    <NetworkMark networkId={network.id} />{network.name}
                  </label>
                ))}</div>
              </fieldset>
              {renderNetworkContentFields(editPostNetworks, editPostNetworkContent, setEditPostNetworkContent, 'edit-network')}
              <label className="field-label" htmlFor="edit-post-format">Formato</label>
              <select id="edit-post-format" onChange={(event) => setEditPostFormat(event.target.value)} value={editPostFormat}>
                {Object.entries(formatOptionsByType).map(([format, label]) => <option key={format} value={format}>{label}</option>)}
              </select>
              <p className="modal-notice">Guardar conserva los cambios en tu borrador. No se publica en redes.</p>
              <div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)} type="button">Cancelar</button><button className="primary-button" type="submit">Guardar cambios</button></div>
            </form>
          )}

          {dialog.type === 'delete-post' && (
            <section className="composer-modal settings-modal" aria-labelledby="delete-post-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">CONFIRMACIÓN</p><h2 id="delete-post-title">Eliminar publicación</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <p className="modal-description">¿Eliminar “{dialog.post.title || dialog.post.text}” de tus borradores? Esta acción no se puede deshacer.</p>
              <div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)} type="button">Cancelar</button><button className="danger-button" onClick={confirmDeletePost} type="button">Eliminar publicación</button></div>
            </section>
          )}

          {dialog.type === 'copy-post' && (
            <section className="composer-modal settings-modal" aria-labelledby="copy-post-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">COPIA INDEPENDIENTE</p><h2 id="copy-post-title">Duplicar publicación</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <p className="modal-description">La copia tendrá un identificador y una marca propios; la publicación original no se modificará.</p>
              <label className="field-label" htmlFor="copy-post-brand">Marca de destino</label>
              <select id="copy-post-brand" onChange={(event) => setCopyBrandId(event.target.value)} value={copyBrandId}>
                {activeWorkspace?.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
              </select>
              <div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)} type="button">Cancelar</button><button className="primary-button" disabled={!copyBrandId} onClick={duplicatePost} type="button">Guardar copia</button></div>
            </section>
          )}

          {dialog.type === 'account-details' && (
            <section className="composer-modal settings-modal" aria-labelledby="account-details-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">{dialog.account.connectionId ? 'CONEXIÓN OFICIAL' : 'CUENTA DE DEMOSTRACIÓN'}</p><h2 id="account-details-title">Detalles de la cuenta</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <div className="detail-list">
                <div><strong>Nombre visible</strong><span>{dialog.account.name}</span></div>
                <div><strong>Red</strong><span>{getNetwork(dialog.account.networkId)?.name}</span></div>
                <div><strong>Estado</strong><span>{dialog.account.connectionId ? dialog.account.status === 'expired' ? 'Token vencido; reconecta para actualizarlo' : `Conexión oficial verificada con ${getNetwork(dialog.account.connectionNetwork || dialog.account.networkId)?.name || 'el proveedor'}` : 'Sin conectar · referencia local de demostración'}</span></div>
                {dialog.account.connectionId && <div><strong>Permisos concedidos</strong><span>{dialog.account.grantedScopes?.join(', ') || 'No se recibieron permisos'}</span></div>}
                <div><strong>Identificador local</strong><span>{dialog.account.id}</span></div>
              </div>
              <p className="modal-notice">{dialog.account.connectionId
                ? 'LOP cifra las credenciales de OAuth en SQLite y no las devuelve al navegador. La conexión no publica contenido.'
                : 'Esta referencia es local; no se ha autorizado ni conectado ninguna cuenta social.'}</p>
              <div className="modal-actions"><button className="primary-button" onClick={() => setDialog(null)} type="button">Cerrar</button></div>
            </section>
          )}

          {dialog.type === 'facebook-page-selection' && (
            <section className="composer-modal settings-modal" aria-labelledby="facebook-page-selection-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">AUTORIZACIÓN DE META</p><h2 id="facebook-page-selection-title">Elige las páginas de Facebook</h2></div><button className="close-button" disabled={savingFacebookPages} onClick={cancelFacebookPageSelection} type="button" aria-label="Cerrar">×</button></div>
              <p className="modal-description">Meta encontró {dialog.selection.pages.length} página(s). Selecciona solo las que quieras conectar y asigna a cada una un espacio y una marca de tu cuenta.</p>
              <p className="modal-notice">Permisos autorizados: {dialog.selection.grantedScopes.join(', ')}. Los tokens de esta selección temporal están cifrados y vencen en 30 minutos. Las páginas no seleccionadas no se guardarán.</p>
              <div className="facebook-page-selection-list">
                {dialog.selection.pages.map((page, index) => {
                  const assignment = facebookPageAssignments[page.id];
                  const pageWorkspaces = workspaces.find((item) => item.id === assignment?.workspaceId)?.brands || [];
                  return (
                    <fieldset className="facebook-page-option" key={page.id}>
                      <legend>
                        <input
                          checked={Boolean(assignment?.selected)}
                          id={`facebook-page-${index}`}
                          onChange={(event) => updateFacebookPageAssignment(page.id, { selected: event.target.checked })}
                          type="checkbox"
                        />
                        <span>{page.name}</span>
                      </legend>
                      {page.tasks.length > 0 && <small>Tareas de página concedidas por Meta: {page.tasks.join(', ')}</small>}
                      <label className="field-label" htmlFor={`facebook-workspace-${index}`}>Espacio</label>
                      <select
                        disabled={!assignment?.selected}
                        id={`facebook-workspace-${index}`}
                        onChange={(event) => {
                          const workspaceId = event.target.value;
                          const brandId = workspaces.find((item) => item.id === workspaceId)?.brands[0]?.id || '';
                          updateFacebookPageAssignment(page.id, { workspaceId, brandId });
                        }}
                        value={assignment?.workspaceId || ''}
                      >
                        {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                      </select>
                      <label className="field-label" htmlFor={`facebook-brand-${index}`}>Marca</label>
                      <select
                        disabled={!assignment?.selected || pageWorkspaces.length === 0}
                        id={`facebook-brand-${index}`}
                        onChange={(event) => updateFacebookPageAssignment(page.id, { brandId: event.target.value })}
                        value={assignment?.brandId || ''}
                      >
                        {pageWorkspaces.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
                      </select>
                    </fieldset>
                  );
                })}
              </div>
              {facebookPageSelectionError && <p className="auth-error" role="alert">{facebookPageSelectionError}</p>}
              <div className="modal-actions">
                <button className="secondary-button" disabled={savingFacebookPages} onClick={cancelFacebookPageSelection} type="button">Cancelar</button>
                <button
                  className="primary-button"
                  disabled={savingFacebookPages || !Object.values(facebookPageAssignments).some((assignment) => assignment.selected)}
                  onClick={confirmFacebookPageSelection}
                  type="button"
                >{savingFacebookPages ? 'Guardando…' : 'Conectar páginas seleccionadas'}</button>
              </div>
            </section>
          )}

          {dialog.type === 'youtube-channel-selection' && (
            <section className="composer-modal settings-modal" aria-labelledby="youtube-channel-selection-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">AUTORIZACIÓN DE GOOGLE</p><h2 id="youtube-channel-selection-title">Elige los canales de YouTube</h2></div><button className="close-button" disabled={savingYoutubeChannels} onClick={cancelYouTubeChannelSelection} type="button" aria-label="Cerrar">×</button></div>
              <p className="modal-description">Google encontró {dialog.selection.channels.length} canal(es). Selecciona solo los que quieras conectar y asigna cada uno a un espacio y una marca.</p>
              <p className="modal-notice">Permiso autorizado: {dialog.selection.grantedScopes.join(', ')}. Las credenciales temporales están cifradas y vencen en 30 minutos. No se publicará contenido.</p>
              <div className="facebook-page-selection-list">
                {dialog.selection.channels.map((channel, index) => {
                  const assignment = youtubeChannelAssignments[channel.id];
                  const channelWorkspaces = workspaces.find((item) => item.id === assignment?.workspaceId)?.brands || [];
                  return (
                    <fieldset className="facebook-page-option" key={channel.id}>
                      <legend>
                        <input
                          checked={Boolean(assignment?.selected)}
                          id={`youtube-channel-${index}`}
                          onChange={(event) => updateYouTubeChannelAssignment(channel.id, { selected: event.target.checked })}
                          type="checkbox"
                        />
                        <span>{channel.name}</span>
                      </legend>
                      {channel.customUrl && <small>{channel.customUrl}</small>}
                      <label className="field-label" htmlFor={`youtube-workspace-${index}`}>Espacio</label>
                      <select
                        disabled={!assignment?.selected}
                        id={`youtube-workspace-${index}`}
                        onChange={(event) => {
                          const workspaceId = event.target.value;
                          const brandId = workspaces.find((item) => item.id === workspaceId)?.brands[0]?.id || '';
                          updateYouTubeChannelAssignment(channel.id, { workspaceId, brandId });
                        }}
                        value={assignment?.workspaceId || ''}
                      >
                        {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                      </select>
                      <label className="field-label" htmlFor={`youtube-brand-${index}`}>Marca</label>
                      <select
                        disabled={!assignment?.selected || channelWorkspaces.length === 0}
                        id={`youtube-brand-${index}`}
                        onChange={(event) => updateYouTubeChannelAssignment(channel.id, { brandId: event.target.value })}
                        value={assignment?.brandId || ''}
                      >
                        {channelWorkspaces.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
                      </select>
                    </fieldset>
                  );
                })}
              </div>
              {youtubeChannelSelectionError && <p className="auth-error" role="alert">{youtubeChannelSelectionError}</p>}
              <div className="modal-actions">
                <button className="secondary-button" disabled={savingYoutubeChannels} onClick={cancelYouTubeChannelSelection} type="button">Cancelar</button>
                <button
                  className="primary-button"
                  disabled={savingYoutubeChannels || !Object.values(youtubeChannelAssignments).some((assignment) => assignment.selected)}
                  onClick={confirmYouTubeChannelSelection}
                  type="button"
                >{savingYoutubeChannels ? 'Guardando…' : 'Conectar canales seleccionados'}</button>
              </div>
            </section>
          )}

          {dialog.type === 'move-connection' && (
            <section className="composer-modal settings-modal" aria-labelledby="move-connection-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">ORGANIZACIÓN DE CUENTA</p><h2 id="move-connection-title">Asignar conexión</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <p className="modal-description">La conexión oficial de <strong>{dialog.account.name}</strong> se asignará a un espacio y una marca de tu cuenta.</p>
              <label className="field-label" htmlFor="connection-workspace">Espacio</label>
              <select id="connection-workspace" onChange={(event) => {
                const workspaceId = event.target.value;
                const firstBrandId = workspaces.find((item) => item.id === workspaceId)?.brands[0]?.id || '';
                setConnectionWorkspaceId(workspaceId);
                setConnectionBrandId(firstBrandId);
              }} value={connectionWorkspaceId}>
                {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <label className="field-label" htmlFor="connection-brand">Marca</label>
              <select id="connection-brand" onChange={(event) => setConnectionBrandId(event.target.value)} value={connectionBrandId}>
                {workspaces.find((item) => item.id === connectionWorkspaceId)?.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
              </select>
              <div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)} type="button">Cancelar</button><button className="primary-button" disabled={!connectionWorkspaceId || !connectionBrandId} onClick={moveConnection} type="button">Guardar asignación</button></div>
            </section>
          )}

          {dialog.type === 'account-manage' && (
            <section className="composer-modal settings-modal" aria-labelledby="manage-account-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">PREFERENCIAS LOCALES</p><h2 id="manage-account-title">Administrar cuenta</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <p className="modal-description"><strong>{dialog.account.name}</strong> · {getNetwork(dialog.account.networkId)?.name} · cuenta de demostración no conectada.</p>
              <div className="settings-row"><div><strong>Incluir en selectores de la demo</strong><span>Preferencia guardada solo en esta sesión.</span></div><button className={`toggle-switch ${accountPreferenceEnabled ? 'on' : ''}`} aria-pressed={accountPreferenceEnabled} onClick={() => setAccountPreferenceEnabled((enabled) => !enabled)} type="button"><span /></button></div>
              <div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)} type="button">Cancelar</button><button className="primary-button" onClick={() => { updateAccount(dialog.account.id, (account) => ({ ...account, preferenceEnabled: accountPreferenceEnabled })); setDialog(null); notify('Preferencias locales de la cuenta guardadas.'); }} type="button">Guardar preferencias</button></div>
            </section>
          )}

          {dialog.type === 'edit-account' && (
            <section className="composer-modal settings-modal" aria-labelledby="edit-account-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">CUENTA DE DEMOSTRACIÓN</p><h2 id="edit-account-title">Editar nombre</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <label className="field-label" htmlFor="edit-account-name">Nombre visible</label>
              <input id="edit-account-name" onChange={(event) => setEditAccountName(event.target.value)} value={editAccountName} />
              <div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)} type="button">Cancelar</button><button className="primary-button" onClick={() => {
                if (!editAccountName.trim()) { notify('El nombre de la cuenta no puede quedar vacío.'); return; }
                updateAccount(dialog.account.id, (account) => ({ ...account, name: editAccountName.trim() }));
                setDialog(null);
                notify('Nombre de la cuenta de demostración actualizado.');
              }} type="button">Guardar nombre</button></div>
            </section>
          )}

          {dialog.type === 'delete-account' && (
            <section className="composer-modal settings-modal" aria-labelledby="delete-account-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">CONFIRMACIÓN</p><h2 id="delete-account-title">{dialog.account.connectionId ? `Desconectar ${getNetwork(dialog.account.connectionNetwork || dialog.account.networkId)?.name || 'cuenta'}` : 'Retirar cuenta de demostración'}</h2></div><button className="close-button" onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <p className="modal-description">{dialog.account.connectionId
                ? `¿Eliminar “${dialog.account.name}” y sus credenciales cifradas de SQLite? Para revocar también el permiso, retira LOP desde la configuración de aplicaciones de ${getNetwork(dialog.account.connectionNetwork || dialog.account.networkId)?.name || 'la red'}.`
                : `¿Retirar “${dialog.account.name}” de tu lista local? Esta referencia no está conectada a una red.`}</p>
              <div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)} type="button">Cancelar</button><button className="danger-button" onClick={confirmDeleteAccount} type="button">{dialog.account.connectionId ? 'Eliminar conexión local' : 'Retirar referencia demo'}</button></div>
            </section>
          )}

          {dialog.type === 'logout' && (
            <section className="composer-modal settings-modal" aria-labelledby="logout-title" aria-modal="true" role="dialog">
              <div className="modal-heading"><div><p className="eyebrow">CONFIRMACIÓN</p><h2 id="logout-title">{dialog.switchUser ? 'Cambiar usuario' : 'Cerrar sesión'}</h2></div><button className="close-button" disabled={loggingOut} onClick={() => setDialog(null)} type="button" aria-label="Cerrar">×</button></div>
              <p className="modal-description">{dialog.switchUser ? 'Cierra esta sesión para acceder con otra cuenta.' : '¿Quieres cerrar tu sesión en este equipo?'}</p>
              {logoutError && <p className="auth-error" role="alert">{logoutError}</p>}
              <div className="modal-actions"><button className="secondary-button" disabled={loggingOut} onClick={() => setDialog(null)} type="button">Cancelar</button><button className="danger-button" disabled={loggingOut} onClick={confirmLogout} type="button">{loggingOut ? 'Cerrando sesión…' : dialog.switchUser ? 'Cambiar usuario' : 'Cerrar sesión'}</button></div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function App() {
  const [workspace, setWorkspace] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [loadingError, setLoadingError] = useState('');
  const sessionGeneration = useRef(0);

  const loadWorkspace = async (user) => {
    const generation = sessionGeneration.current;
    const [data, workspaceData] = await Promise.all([
      apiRequest('/data'),
      apiRequest('/workspaces'),
    ]);
    if (generation !== sessionGeneration.current) return;
    setLoadingError('');
    setWorkspace({ user, data, workspaces: workspaceData.workspaces });
  };

  useEffect(() => {
    let active = true;
    const restoreSession = async () => {
      const generation = ++sessionGeneration.current;
      setCheckingSession(true);
      setLoadingError('');
      setWorkspace(null);
      try {
        const { user } = await apiRequest('/auth/session');
      const [data, workspaceData] = await Promise.all([
        apiRequest('/data'),
        apiRequest('/workspaces'),
      ]);
      if (active && generation === sessionGeneration.current) {
        setWorkspace({ user, data, workspaces: workspaceData.workspaces });
      }
      } catch (error) {
        if (active && generation === sessionGeneration.current && error.status !== 401) {
          setLoadingError(error.message);
        }
      } finally {
        if (active && generation === sessionGeneration.current) {
          setCheckingSession(false);
          delete document.documentElement.dataset.sessionCheck;
        }
      }
    };
    const handlePageHide = () => {
      sessionGeneration.current += 1;
      document.documentElement.dataset.sessionCheck = 'true';
      setWorkspace(null);
      setCheckingSession(true);
    };
    const handlePageShow = (event) => {
      if (!event.persisted) return;
      document.documentElement.dataset.sessionCheck = 'true';
      void restoreSession();
    };

    void restoreSession();
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      active = false;
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, []);

  useEffect(() => {
    if (!workspace) return undefined;
    let checking = false;
    const verifySession = async () => {
      if (checking || document.visibilityState === 'hidden') return;
      checking = true;
      try {
        await apiRequest('/auth/session');
      } catch (error) {
        if (error.status === 401) {
          try {
            await apiRequest('/auth/logout', { method: 'POST' });
          } catch (logoutError) {
            console.error('No se pudo limpiar la cookie de una sesión revocada:', logoutError.message);
          }
          sessionGeneration.current += 1;
          setLoadingError('');
          setWorkspace(null);
          setCheckingSession(false);
          window.location.replace('/');
        } else {
          console.error('No se pudo comprobar la sesión activa:', error.message);
        }
      } finally {
        checking = false;
      }
    };
    const interval = window.setInterval(verifySession, 5000);
    window.addEventListener('focus', verifySession);
    document.addEventListener('visibilitychange', verifySession);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', verifySession);
      document.removeEventListener('visibilitychange', verifySession);
    };
  }, [workspace?.user.id]);

  const changeWorkspace = async (workspaceId) => {
    if (!workspace) return;
    await apiRequest('/workspaces/active', {
      method: 'PUT',
      body: JSON.stringify({ workspaceId }),
    });
    const [data, workspaceData] = await Promise.all([
      apiRequest('/data'),
      apiRequest('/workspaces'),
    ]);
    setWorkspace({ user: workspace.user, data, workspaces: workspaceData.workspaces });
  };

  const handleLogout = async (pendingSaves) => {
    sessionGeneration.current += 1;
    const logoutRequest = apiRequest('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
    const pendingChangesFailed = pendingSaves
      ? await Promise.race([pendingSaves, logoutRequest.then(() => null)])
      : false;
    await logoutRequest;
    setLoadingError('');
    setWorkspace(null);
    setCheckingSession(false);
    if (pendingChangesFailed !== false) {
      window.sessionStorage.setItem(
        'lop-logout-notice',
        'La sesión se cerró en todos tus navegadores. Algunos cambios pendientes no pudieron guardarse; los datos ya guardados permanecen intactos.',
      );
    }
    window.location.replace('/');
  };

  const content = workspace
    ? <WorkspaceApp
      key={`${workspace.user.id}:${workspace.data.workspaceId}`}
      user={workspace.user}
      initialData={workspace.data}
      initialWorkspaces={workspace.workspaces}
      onLogout={handleLogout}
      onWorkspaceChange={changeWorkspace}
    />
    : checkingSession
      ? <main className="auth-page"><p role="status">Cargando tu espacio…</p></main>
      : loadingError
        ? <main className="auth-page"><section className="auth-card"><h1>No se pudo conectar</h1><p className="auth-error" role="alert">{loadingError}</p><p>Comprueba que el servidor local esté iniciado y vuelve a cargar la página.</p></section></main>
        : <AuthScreen onAuthenticated={async (user) => {
          try {
            await loadWorkspace(user);
          } catch (error) {
            let message = error.message;
            try {
              await apiRequest('/auth/logout', { method: 'POST' });
            } catch (logoutError) {
              message = `${message} No se pudo invalidar la sesión: ${logoutError.message}`;
            }
            setLoadingError(message);
            setWorkspace(null);
            throw error;
          }
        }} />;

  return content;
}

export default App;
