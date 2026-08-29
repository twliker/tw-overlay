/**
 * 기능 계약 — Discord 웹훅 알림
 *
 * - 사용자가 Discord 설정 창에서 기능을 켜고 HTTPS 웹훅 URL을 저장한 경우에만 실제 메시지를
 *   전송합니다. 테스트 전송만 전달받은 URL과 일회성 enabled override를 사용합니다.
 * - 현재 자동 전송 대상은 지정 단어 감지이며, payload에는 해당 알림에 필요한 발신자·메시지·매칭
 *   키워드가 포함됩니다. GA 사용 통계와는 완전히 별도이며 Discord 전송 내용을 GA에 복제하지 않습니다.
 * - 2xx만 성공으로 처리하고 네트워크 오류와 비정상 응답은 호출자에게 reject하여 UI가 실패를
 *   사용자에게 알릴 수 있게 합니다. 실패했다고 로컬 설정을 끄거나 웹훅 URL을 삭제하지 않습니다.
 * - 웹훅 URL은 인증 정보이므로 로그·분석 이벤트·백업 문서에 원문을 추가로 노출하지 않습니다.
 */
import * as https from 'https';
import * as url from 'url';
import * as config from './config';
import { log } from './logger';

class DiscordNotifier {
  /**
   * 디스코드 웹훅에 JSON payload를 전송합니다.
   */
  private sendWebhook(payload: any, overrideUrl?: string, overrideEnabled?: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const cfg = config.load();
      const isEnabled = overrideEnabled !== undefined ? overrideEnabled : (cfg.discordAlertEnabled ?? false);
      const webhookUrl = (overrideUrl || cfg.discordWebhookUrl || '').trim();

      if (!isEnabled) {
        return resolve();
      }

      if (!webhookUrl) {
        return reject(new Error('Discord Webhook URL이 설정되지 않았습니다.'));
      }

      if (!webhookUrl.startsWith('https://')) {
        log(`[DISCORD] 유효하지 않은 웹훅 URL입니다. (https로 시작해야 함)`);
        return reject(new Error('Invalid Webhook URL (Must start with https://)'));
      }

      try {
        const parsedUrl = new url.URL(webhookUrl);
        const postData = JSON.stringify(payload);

        const options: https.RequestOptions = {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        };

        const req = https.request(options, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              log(`[DISCORD] 웹훅 전송 실패. 응답코드: ${res.statusCode}, 바디: ${body}`);
              reject(new Error(`HTTP Status Code: ${res.statusCode}`));
            }
          });
        });

        req.on('error', (err) => {
          log(`[DISCORD] 요청 에러: ${err.message}`);
          reject(err);
        });

        req.write(postData);
        req.end();
      } catch (e: any) {
        log(`[DISCORD] URL 분석 예외: ${e.message}`);
        reject(e);
      }
    });
  }



  /**
   * 지정 단어 알림 발송
   */
  public async sendWord(sender: string, message: string, matchedKeyword: string): Promise<void> {
    const cfg = config.load();

    const payload = {
      username: 'TW-Overlay 키워드 알리미',
      embeds: [
        {
          title: `💬 지정 단어 감지 [@${matchedKeyword}]`,
          description: `**${sender}**: ${message}`,
          color: 3447003, // 청색 (Blue)
          timestamp: new Date().toISOString(),
          footer: {
            text: 'TalesWeaver Companion (TW-Overlay)'
          }
        }
      ]
    };

    try {
      await this.sendWebhook(payload);
      log(`[DISCORD] 지정 단어 알림 웹훅 발송 성공: [${sender}] ${message}`);
    } catch (e: any) {
      log(`[DISCORD] 지정 단어 알림 웹훅 발송 실패: ${e.message}`);
    }
  }

  /**
   * 웹훅 연동 테스트 전송
   */
  public async sendTest(webhookUrl: string): Promise<void> {
    const payload = {
      username: 'TW-Overlay 테스트 봇',
      embeds: [
        {
          title: '🔔 디스코드 알림 연동 성공!',
          description: 'TW-Overlay와의 디스코드 웹훅 알림 연동 테스트가 성공적으로 완료되었습니다.',
          color: 3066993, // 녹색
          fields: [
            { name: '테스트 시간', value: new Date().toLocaleString('ko-KR') },
            { name: '작동 상태', value: '정상 (Online)' }
          ],
          timestamp: new Date().toISOString(),
          footer: {
            text: 'TalesWeaver Companion (TW-Overlay)'
          }
        }
      ]
    };

    // 설정 비활성화 상태여도 테스트는 강제로 전송 허용
    await this.sendWebhook(payload, webhookUrl, true);
  }
}

export const discordNotifier = new DiscordNotifier();
