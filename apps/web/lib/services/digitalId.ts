import QRCode from 'qrcode';

interface DigitalIdPayload {
  touristId: string;
  name: string;
  nationality: string;
  verified: boolean;
  did: string;
  issueDate: string;
}


export async function generateDigitalIdQr(didString: string): Promise<string> {
  try {
    const qrDataUrl = await QRCode.toDataURL(didString, {
      width: 280,
      margin: 2,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    });
    return qrDataUrl;
  } catch (err) {
    console.error('Error generating QR code:', err);
    throw err;
  }
}
