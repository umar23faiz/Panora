import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '@@core/prisma/prisma.service';
import {
  CallbackParams,
  ICrmConnectionService,
  RefreshParams,
  ZohoOAuthResponse,
} from '../../types';
import { LoggerService } from '@@core/logger/logger.service';
import { Action, NotFoundError, handleServiceError } from '@@core/utils/errors';
import { v4 as uuidv4 } from 'uuid';
import { EnvironmentService } from '@@core/environment/environment.service';
import { EncryptionService } from '@@core/encryption/encryption.service';

const ZOHOLocations = {
  us: 'https://accounts.zoho.com',
  eu: 'https://accounts.zoho.eu',
  in: 'https://accounts.zoho.in',
  au: 'https://accounts.zoho.com.au',
  jp: 'https://accounts.zoho.jp',
};
@Injectable()
export class ZohoConnectionService implements ICrmConnectionService {
  constructor(
    private prisma: PrismaService,
    private logger: LoggerService,
    private env: EnvironmentService,
    private cryptoService: EncryptionService,
  ) {
    this.logger.setContext(ZohoConnectionService.name);
  }
  async handleCallback(opts: CallbackParams) {
    try {
      const { linkedUserId, projectId, code, location } = opts;
      if (!location) {
        throw new NotFoundError(`no zoho location, found ${location}`);
      }
      const isNotUnique = await this.prisma.connections.findFirst({
        where: {
          id_linked_user: linkedUserId,
          provider_slug: 'zoho',
        },
      });

      //reconstruct the redirect URI that was passed in the frontend it must be the same
      const REDIRECT_URI = `${this.env.getOAuthRredirectBaseUrl()}/connections/oauth/callback`;

      const formData = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.env.getZohoSecret().CLIENT_ID,
        client_secret: this.env.getZohoSecret().CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code: code,
      });
      //no refresh token
      const domain = ZOHOLocations[location];
      const res = await axios.post(
        `${domain}/oauth/v2/token`,
        formData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          },
        },
      );
      const data: ZohoOAuthResponse = res.data;
      this.logger.log('OAuth credentials : zoho ' + JSON.stringify(data));
      let db_res;

      if (isNotUnique) {
        db_res = await this.prisma.connections.update({
          where: {
            id_connection: isNotUnique.id_connection,
          },
          data: {
            access_token: this.cryptoService.encrypt(data.access_token),
            refresh_token: data.refresh_token
              ? this.cryptoService.encrypt(data.refresh_token)
              : '',
            expiration_timestamp: new Date(
              new Date().getTime() + data.expires_in * 1000,
            ),
            status: 'valid',
            created_at: new Date(),
            account_url: domain,
          },
        });
      } else {
        db_res = await this.prisma.connections.create({
          data: {
            id_connection: uuidv4(),
            provider_slug: 'zoho',
            token_type: 'oauth',
            access_token: this.cryptoService.encrypt(data.access_token),
            refresh_token: data.refresh_token
              ? this.cryptoService.encrypt(data.refresh_token)
              : '',
            expiration_timestamp: new Date(
              new Date().getTime() + data.expires_in * 1000,
            ),
            status: 'valid',
            created_at: new Date(),
            projects: {
              connect: { id_project: projectId },
            },
            linked_users: {
              connect: { id_linked_user: linkedUserId },
            },
            account_url: domain,
          },
        });
      }

      return db_res;
    } catch (error) {
      handleServiceError(error, this.logger, 'zoho', Action.oauthCallback);
    }
  }
  async handleTokenRefresh(opts: RefreshParams) {
    try {
      const { connectionId, refreshToken, account_url } = opts;
      const REDIRECT_URI = `${this.env.getOAuthRredirectBaseUrl()}/connections/oauth/callback`;
      const formData = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.env.getZohoSecret().CLIENT_ID,
        client_secret: this.env.getZohoSecret().CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        refresh_token: this.cryptoService.decrypt(refreshToken),
      });

      const res = await axios.post(
        `${account_url}/oauth/v2/token`,
        formData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          },
        },
      );
      const data: ZohoOAuthResponse = res.data;
      await this.prisma.connections.update({
        where: {
          id_connection: connectionId,
        },
        data: {
          access_token: this.cryptoService.encrypt(data.access_token),
          expiration_timestamp: new Date(
            new Date().getTime() + data.expires_in * 1000,
          ),
        },
      });
      this.logger.log('OAuth credentials updated : zoho ');
    } catch (error) {
      handleServiceError(error, this.logger, 'zoho', Action.oauthRefresh);
    }
  }
}
