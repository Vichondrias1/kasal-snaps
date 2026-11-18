// ---------------------------------------------------------------------------
//  Your wedding details — the ONLY file you need to edit.
//
//  These are placeholder values. Two ways to use your real ones:
//
//   A) Private repo: just edit the values below, commit, and deploy.
//   B) Public repo: leave this file alone and put your real values in
//      Cloudflare instead (see README → "Keep your details out of GitHub").
//      Every value here can be overridden by the variable named on its right.
// ---------------------------------------------------------------------------

export default {
  // Shown as the big title on the guest page.            Override: COUPLE_NAMES
  coupleNames: "Alex & Sam",

  // Your wedding day, as YYYY-MM-DD. Everything else follows from it: the date
  // shown under your names and on the QR card, the countdown, and when guests
  // can upload. You can also change it later on the admin page
  // (Settings & clean-up → Wedding date) without redeploying.
  weddingDay: "2027-09-18", //                            Override: WEDDING_DAY

  // Guests can upload from this time on the wedding day…  Override: UPLOAD_OPENS_AT
  uploadOpensAt: "12:00",
  // …for this many days, until 11:59 pm on the last one.  Override: UPLOAD_DAYS
  uploadDays: 7,

  // Shown next to the date. Leave "" to hide.            Override: VENUE
  venue: "The Garden Pavilion",

  // A short line for your guests.                        Override: WELCOME_MESSAGE
  welcomeMessage:
    "Thank you for celebrating with us! Share every photo and video you take today — we can't wait to see the day through your eyes.",

  // Advanced, optional. Leave "" to work these out from weddingDay above.
  // The shown date text, e.g. "18 September 2027".       Override: WEDDING_DATE
  weddingDate: "",
  // Exact upload window, as YYYY-MM-DDTHH:MM:SS+HH:MM (the +HH:MM is your
  // time zone's offset from UTC).          Override: UPLOAD_OPENS, UPLOAD_CLOSES
  uploadOpens: "",
  uploadCloses: "",

  // Your time zone, used for the upload times and dates.  Override: TIMEZONE
  // List: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
  timezone: "America/New_York",

  // Colours (hex codes).
  colors: {
    background: "#FBF8F1", // ivory                      Override: COLOR_BACKGROUND
    primary: "#7D8F69", //    sage — buttons & accents    Override: COLOR_PRIMARY
    text: "#3B3A36", //       dark text                   Override: COLOR_TEXT
    accent: "#B89A6E", //     thin lines & card border    Override: COLOR_ACCENT
  },

  // "serif" (elegant, Cormorant Garamond) or "modern" (clean sans-serif).
  font: "serif", //                                       Override: FONT

  // Optional header photo: a full https:// link, or a file you put in the
  // public/ folder (e.g. "/header.jpg"). Leave "" for none. You can also
  // upload one from the admin page instead.               Override: HEADER_PHOTO
  headerPhoto: "",

  // Optional: the address printed on the QR card. Leave "" to use whatever
  // address you open the admin page at.                   Override: SITE_URL
  siteUrl: "",

  // Optional venue Wi-Fi, printed as a second QR code on the table card so
  // guests can join before uploading. Leave "" for no Wi-Fi code. You can also
  // type these on the QR card page instead. Only the admin-only QR card page
  // ever sees them.
  wifiName: "", //                                        Override: WIFI_NAME
  wifiPassword: "", //                                    Override: WIFI_PASSWORD
  wifiSecurity: "WPA", // "WPA" (almost all), "WEP", or "nopass" for open Wi-Fi.  Override: WIFI_SECURITY

  // Free R2 storage, used for the storage meter on the admin page.
  storageLimitGB: 10,
};
