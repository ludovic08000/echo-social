/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Button, Container, Head, Heading, Hr, Html, Img, Preview, Section, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'Forsure'
const LOGO = 'https://vkpmoqfzrihcijjochks.supabase.co/storage/v1/object/public/email-assets/forsure-logo.png'

interface Props {
  location?: string
  ip?: string
  userAgent?: string
  approveUrl?: string
  rejectUrl?: string
  when?: string
}

const NewDeviceLoginEmail = ({ location, ip, userAgent, approveUrl, rejectUrl, when }: Props) => (
  <Html lang="fr" dir="ltr">
    <Head />
    <Preview>Nouvelle connexion détectée — confirmez que c'est bien vous</Preview>
    <Body style={main}>
      <Container style={container}>
        <Img src={LOGO} alt="Forsure" width="140" height="auto" style={logo} />
        <Heading style={h1}>Nouvelle connexion détectée</Heading>
        <Text style={text}>
          Une connexion à votre compte vient d'être effectuée depuis un appareil que nous ne reconnaissons pas.
        </Text>

        <Section style={infoBox}>
          <Text style={infoLine}><strong>Lieu :</strong> {location || 'Inconnu'}</Text>
          {when && <Text style={infoLine}><strong>Quand :</strong> {when}</Text>}
          {ip && <Text style={infoLine}><strong>IP :</strong> {ip}</Text>}
          {userAgent && <Text style={infoLineSmall}>{userAgent}</Text>}
        </Section>

        <Text style={text}>
          <strong>Si c'est bien vous</strong>, validez cet appareil :
        </Text>
        <Button href={approveUrl} style={btnApprove}>✓ C'est bien moi</Button>

        <Text style={textWarn}>
          <strong>Si ce n'est pas vous</strong>, révoquez cet appareil et changez immédiatement votre mot de passe :
        </Text>
        <Button href={rejectUrl} style={btnReject}>⚠ Ce n'est pas moi</Button>

        <Hr style={hr} />
        <Text style={footer}>
          Cette alerte est envoyée car votre sécurité est notre priorité absolue. Chaque appareil reçoit une clé unique chiffrée en SHA-256.
          <br /><br />
          — L'équipe {SITE_NAME}
        </Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: NewDeviceLoginEmail,
  subject: '🔒 Nouvelle connexion à votre compte Forsure',
  displayName: 'Alerte nouvelle connexion',
  previewData: {
    location: 'New York, États-Unis',
    ip: '203.0.113.42',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)',
    approveUrl: 'https://forsure.fans/security/device?token=demo&action=approve',
    rejectUrl: 'https://forsure.fans/security/device?token=demo&action=reject',
    when: '03/05/2026 14:32',
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: "'Playfair Display', Georgia, serif" }
const container = { padding: '30px 25px', maxWidth: '520px', margin: '0 auto' }
const logo = { margin: '0 auto 24px', display: 'block' as const }
const h1 = { fontSize: '24px', fontWeight: 'bold' as const, color: '#1a2744', margin: '0 0 20px', textAlign: 'center' as const }
const text = { fontSize: '15px', color: '#3a4358', lineHeight: '1.6', margin: '0 0 16px' }
const textWarn = { fontSize: '15px', color: '#a92020', lineHeight: '1.6', margin: '24px 0 12px' }
const infoBox = { backgroundColor: '#f5f7fb', padding: '16px 20px', borderRadius: '14px', margin: '12px 0 24px', border: '1px solid #e3e8f1' }
const infoLine = { fontSize: '14px', color: '#1a2744', margin: '4px 0', lineHeight: '1.5' }
const infoLineSmall = { fontSize: '11px', color: '#8088a0', margin: '6px 0 0', lineHeight: '1.4', wordBreak: 'break-all' as const }
const btnApprove = { backgroundColor: '#002395', color: '#ffffff', padding: '12px 28px', borderRadius: '999px', fontSize: '15px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block', margin: '0 0 8px' }
const btnReject = { backgroundColor: '#ED2939', color: '#ffffff', padding: '12px 28px', borderRadius: '999px', fontSize: '15px', fontWeight: 'bold' as const, textDecoration: 'none', display: 'inline-block' }
const hr = { borderColor: '#e3e8f1', margin: '32px 0 20px' }
const footer = { fontSize: '12px', color: '#8088a0', margin: '0', textAlign: 'center' as const, lineHeight: '1.6' }
