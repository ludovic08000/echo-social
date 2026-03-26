/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'Forsure'
const LOGO = 'https://vkpmoqfzrihcijjochks.supabase.co/storage/v1/object/public/email-assets/forsure-logo.png'

interface PinResetCodeProps {
  code?: string
  name?: string
}

const PinResetCodeEmail = ({ code = '------', name }: PinResetCodeProps) => (
  <Html lang="fr" dir="ltr">
    <Head />
    <Preview>Votre code de réinitialisation PIN — {SITE_NAME}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Img src={LOGO} alt="Forsure" width="140" height="auto" style={logo} />
        <Heading style={h1}>Réinitialisation du code PIN</Heading>
        <Text style={text}>
          {name ? `Bonjour ${name},` : 'Bonjour,'}
        </Text>
        <Text style={text}>
          Vous avez demandé la réinitialisation de votre code PIN de messagerie.
          Voici votre code de vérification :
        </Text>
        <Text style={codeStyle}>{code}</Text>
        <Text style={text}>
          Ce code expire dans <strong>10 minutes</strong>. Si vous n'avez pas
          fait cette demande, ignorez cet email.
        </Text>
        <Text style={footer}>
          — L'équipe {SITE_NAME}
        </Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: PinResetCodeEmail,
  subject: 'Votre code de réinitialisation PIN — Forsure',
  displayName: 'Code de réinitialisation PIN',
  previewData: { code: '847291', name: 'Marie' },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: "'Playfair Display', Georgia, serif" }
const container = { padding: '30px 25px', maxWidth: '480px', margin: '0 auto' }
const logo = { margin: '0 auto 24px', display: 'block' as const }
const h1 = { fontSize: '24px', fontWeight: 'bold' as const, color: '#1a2744', margin: '0 0 20px', textAlign: 'center' as const }
const text = { fontSize: '15px', color: '#636b7d', lineHeight: '1.6', margin: '0 0 20px' }
const codeStyle = {
  fontSize: '36px',
  fontWeight: 'bold' as const,
  color: '#2563eb',
  textAlign: 'center' as const,
  letterSpacing: '8px',
  padding: '20px 0',
  margin: '0 0 20px',
  backgroundColor: '#f0f4ff',
  borderRadius: '16px',
  border: '2px solid #dbeafe',
}
const footer = { fontSize: '12px', color: '#999999', margin: '30px 0 0', textAlign: 'center' as const }
