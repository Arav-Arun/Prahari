import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

/* Photographic props framing the page corners — traveller kit down the left,
   authority kit down the right. Decorative only; the centre column stays clear. */
const ART = [
  { src: '/hero/map-india.webp', className: 'art-map', w: 1103, h: 857 },
  { src: '/hero/backpack.webp', className: 'art-backpack', w: 558, h: 549 },
  { src: '/hero/passport.webp', className: 'art-passport', w: 236, h: 335 },
  { src: '/hero/classified.webp', className: 'art-classified', w: 487, h: 598 },
  { src: '/hero/badge.webp', className: 'art-badge', w: 307, h: 371 },
  { src: '/hero/radio.webp', className: 'art-radio', w: 458, h: 490 },
];

export default function Home() {
  return (
    <div className="landing-shell">
      <div className="landing-art" aria-hidden="true">
        {ART.map((art) => (
          <Image key={art.src} src={art.src} alt="" width={art.w} height={art.h} className={art.className} priority />
        ))}
      </div>

      <nav className="landing-nav" aria-label="Main">
        <Link href="/" className="landing-brand">Prahari</Link>
        <div className="landing-nav-links">
          <Link href="/login">Sign in</Link>
          <Link href="/onboarding" className="landing-nav-cta">Create tourist ID</Link>
        </div>
      </nav>

      <main className="landing-main">
        <section className="landing-hero">
          <h1 className="landing-title">
            Travel with a <strong>verified ID.</strong>
            <br />
            <em>Get help when it matters.</em>
          </h1>
          <p className="landing-copy">
            Prahari gives travellers a digital safety ID, optional location sharing,
            and a direct emergency route to authorised responders.
          </p>
        </section>

        <section className="landing-roles" aria-label="Choose your portal">
          <article className="role-card">
            <h2>For travellers</h2>
            <p>
              Get a digital tourist ID, keep emergency contacts on file, and send an SOS
              with your location when you need help.
            </p>
            <div className="role-actions">
              <Link href="/onboarding" className="role-btn-primary">
                Create tourist ID <ArrowRight size={16} />
              </Link>
              <Link href="/login?role=tourist" className="role-btn-secondary">
                Traveller sign in <ArrowRight size={16} />
              </Link>
            </div>
          </article>

          <article className="role-card">
            <h2>For authorised staff</h2>
            <p>
              Review live incidents, publish geofences, and verify traveller credentials
              from one operations desk.
            </p>
            <div className="role-actions">
              <Link href="/login?role=staff" className="role-btn-primary">
                Open the authority desk <ArrowRight size={16} />
              </Link>
            </div>
          </article>
        </section>
      </main>

      <footer className="landing-footer">
        Prototype — not a government emergency service. In an emergency, call <a href="tel:112">112</a>.
      </footer>
    </div>
  );
}
