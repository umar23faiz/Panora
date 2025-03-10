import { Injectable } from '@nestjs/common';
import { PrismaService } from '@@core/prisma/prisma.service';
import { ContactResponse, IContactService } from '../types';
import { desunify } from '@@core/utils/unification/desunify';
import { CrmObject } from '@crm/@utils/@types';
import { LoggerService } from '@@core/logger/logger.service';
import { unify } from '@@core/utils/unification/unify';
import { v4 as uuidv4 } from 'uuid';
import {
  UnifiedContactInput,
  UnifiedContactOutput,
} from '@crm/contact/types/model.unified';
import { ApiResponse } from '@@core/utils/types';
import { handleServiceError } from '@@core/utils/errors';
import { FieldMappingService } from '@@core/field-mapping/field-mapping.service';
import { WebhookService } from '@@core/webhook/webhook.service';
import { normalizeEmailsAndNumbers } from '@crm/contact/utils';
import { OriginalContactOutput } from '@@core/utils/types/original/original.crm';
import { ServiceRegistry } from './registry.service';

@Injectable()
export class ContactService {
  constructor(
    private prisma: PrismaService,
    private logger: LoggerService,
    private fieldMappingService: FieldMappingService,
    private webhook: WebhookService,
    private serviceRegistry: ServiceRegistry,
  ) {
    this.logger.setContext(ContactService.name);
  }

  async batchAddContacts(
    unifiedContactData: UnifiedContactInput[],
    integrationId: string,
    linkedUserId: string,
    remote_data?: boolean,
  ): Promise<ApiResponse<ContactResponse>> {
    try {
      const responses = await Promise.all(
        unifiedContactData.map((unifiedData) =>
          this.addContact(
            unifiedData,
            integrationId.toLowerCase(),
            linkedUserId,
            remote_data,
          ),
        ),
      );

      const allContacts = responses.flatMap(
        (response) => response.data.contacts,
      );
      const allRemoteData = responses.flatMap(
        (response) => response.data.remote_data || [],
      );

      return {
        data: {
          contacts: allContacts,
          remote_data: allRemoteData,
        },
        message: 'All contacts inserted successfully',
        statusCode: 201,
      };
    } catch (error) {
      handleServiceError(error, this.logger);
    }
  }

  async addContact(
    unifiedContactData: UnifiedContactInput,
    integrationId: string,
    linkedUserId: string,
    remote_data?: boolean,
  ): Promise<ApiResponse<ContactResponse>> {
    try {
      const linkedUser = await this.prisma.linked_users.findUnique({
        where: {
          id_linked_user: linkedUserId,
        },
      });
      const job_resp_create = await this.prisma.events.create({
        data: {
          id_event: uuidv4(),
          status: 'initialized',
          type: 'crm.contact.created', //sync, push or pull
          method: 'POST',
          url: '/crm/contact',
          provider: integrationId,
          direction: '0',
          timestamp: new Date(),
          id_linked_user: linkedUserId,
        },
      });
      const job_id = job_resp_create.id_event;

      // Retrieve custom field mappings
      // get potential fieldMappings and extract the original properties name
      const customFieldMappings =
        await this.fieldMappingService.getCustomFieldMappings(
          integrationId,
          linkedUserId,
          'contact',
        );
      //desunify the data according to the target obj wanted
      const desunifiedObject = await desunify<UnifiedContactInput>({
        sourceObject: unifiedContactData,
        targetType: CrmObject.contact,
        providerName: integrationId,
        customFieldMappings: unifiedContactData.field_mappings
          ? customFieldMappings
          : [],
      });

      const service: IContactService =
        this.serviceRegistry.getService(integrationId);
      const resp: ApiResponse<OriginalContactOutput> = await service.addContact(
        desunifiedObject,
        linkedUserId,
      );

      //unify the data according to the target obj wanted
      const unifiedObject = (await unify<OriginalContactOutput[]>({
        sourceObject: [resp.data],
        targetType: CrmObject.contact,
        providerName: integrationId,
        customFieldMappings: customFieldMappings,
      })) as UnifiedContactOutput[];

      // add the contact inside our db
      const source_contact = resp.data;
      const target_contact = unifiedObject[0];
      const originId =
        'id' in source_contact
          ? String(source_contact.id)
          : 'contact_id' in source_contact
          ? String(source_contact.contact_id)
          : undefined;

      const existingContact = await this.prisma.crm_contacts.findFirst({
        where: {
          remote_id: originId,
          remote_platform: integrationId,
          events: {
            id_linked_user: linkedUserId,
          },
        },
        include: { crm_email_addresses: true, crm_phone_numbers: true },
      });

      const { normalizedEmails, normalizedPhones } = normalizeEmailsAndNumbers(
        target_contact.email_addresses,
        target_contact.phone_numbers,
      );

      let unique_crm_contact_id: string;

      if (existingContact) {
        // Update the existing contact
        const res = await this.prisma.crm_contacts.update({
          where: {
            id_crm_contact: existingContact.id_crm_contact,
          },
          data: {
            first_name: target_contact.first_name || '',
            last_name: target_contact.last_name || '',
            modified_at: new Date(),
            crm_email_addresses: {
              update: normalizedEmails.map((email, index) => ({
                where: {
                  id_crm_email:
                    existingContact.crm_email_addresses[index].id_crm_email,
                },
                data: email,
              })),
            },
            crm_phone_numbers: {
              update: normalizedPhones.map((phone, index) => ({
                where: {
                  id_crm_phone_number:
                    existingContact.crm_phone_numbers[index]
                      .id_crm_phone_number,
                },
                data: phone,
              })),
            },
          },
        });
        unique_crm_contact_id = res.id_crm_contact;
      } else {
        // Create a new contact
        this.logger.log('not existing contact ' + target_contact.first_name);
        const data = {
          id_crm_contact: uuidv4(),
          first_name: target_contact.first_name || '',
          last_name: target_contact.last_name || '',
          created_at: new Date(),
          modified_at: new Date(),
          id_event: job_id,
          remote_id: originId,
          remote_platform: integrationId,
        };

        if (normalizedEmails) {
          data['crm_email_addresses'] = {
            create: normalizedEmails,
          };
        }

        if (normalizedPhones) {
          data['crm_phone_numbers'] = {
            create: normalizedPhones,
          };
        }
        const res = await this.prisma.crm_contacts.create({
          data: data,
        });
        unique_crm_contact_id = res.id_crm_contact;
      }

      // check duplicate or existing values
      if (
        target_contact.field_mappings &&
        target_contact.field_mappings.length > 0
      ) {
        const entity = await this.prisma.entity.create({
          data: {
            id_entity: uuidv4(),
            ressource_owner_id: unique_crm_contact_id,
          },
        });

        for (const mapping of target_contact.field_mappings) {
          const attribute = await this.prisma.attribute.findFirst({
            where: {
              slug: Object.keys(mapping)[0],
              source: integrationId,
              id_consumer: linkedUserId,
            },
          });

          if (attribute) {
            await this.prisma.value.create({
              data: {
                id_value: uuidv4(),
                data: Object.values(mapping)[0] || 'null',
                attribute: {
                  connect: {
                    id_attribute: attribute.id_attribute,
                  },
                },
                entity: {
                  connect: {
                    id_entity: entity.id_entity,
                  },
                },
              },
            });
          }
        }
      }
      if (remote_data) {
        //insert remote_data in db
        await this.prisma.remote_data.upsert({
          where: {
            ressource_owner_id: unique_crm_contact_id,
          },
          create: {
            id_remote_data: uuidv4(),
            ressource_owner_id: unique_crm_contact_id,
            format: 'json',
            data: JSON.stringify(source_contact),
            created_at: new Date(),
          },
          update: {
            data: JSON.stringify(source_contact),
            created_at: new Date(),
          },
        });
      }

      /////
      const result_contact = await this.getContact(
        unique_crm_contact_id,
        remote_data,
      );

      const status_resp = resp.statusCode === 201 ? 'success' : 'fail';
      await this.prisma.events.update({
        where: {
          id_event: job_id,
        },
        data: {
          status: status_resp,
        },
      });
      await this.webhook.handleWebhook(
        result_contact.data.contacts,
        'crm.contact.created',
        linkedUser.id_project,
        job_id,
      );
      return { ...resp, data: result_contact.data };
    } catch (error) {
      handleServiceError(error, this.logger);
    }
  }

  async getContact(
    id_crm_contact: string,
    remote_data?: boolean,
  ): Promise<ApiResponse<ContactResponse>> {
    try {
      const contact = await this.prisma.crm_contacts.findUnique({
        where: {
          id_crm_contact: id_crm_contact,
        },
        include: {
          crm_email_addresses: true,
          crm_phone_numbers: true,
        },
      });

      // Fetch field mappings for the contact
      const values = await this.prisma.value.findMany({
        where: {
          entity: {
            ressource_owner_id: contact.id_crm_contact,
          },
        },
        include: {
          attribute: true,
        },
      });

      // Create a map to store unique field mappings
      const fieldMappingsMap = new Map();

      values.forEach((value) => {
        fieldMappingsMap.set(value.attribute.slug, value.data);
      });

      // Convert the map to an array of objects
      const field_mappings = Array.from(fieldMappingsMap, ([key, value]) => ({
        [key]: value,
      }));

      // Transform to UnifiedContactInput format
      const unifiedContact: UnifiedContactOutput = {
        id: contact.id_crm_contact,
        first_name: contact.first_name,
        last_name: contact.last_name,
        email_addresses: contact.crm_email_addresses.map((email) => ({
          email_address: email.email_address,
          email_address_type: email.email_address_type,
        })),
        phone_numbers: contact.crm_phone_numbers.map((phone) => ({
          phone_number: phone.phone_number,
          phone_type: phone.phone_type,
        })),
        field_mappings: field_mappings,
      };

      let res: ContactResponse = {
        contacts: [unifiedContact],
      };

      if (remote_data) {
        const resp = await this.prisma.remote_data.findFirst({
          where: {
            ressource_owner_id: contact.id_crm_contact,
          },
        });
        const remote_data = JSON.parse(resp.data);

        res = {
          ...res,
          remote_data: [remote_data],
        };
      }

      return {
        data: res,
        statusCode: 200,
      };
    } catch (error) {
      handleServiceError(error, this.logger);
    }
  }

  async getContacts(
    integrationId: string,
    linkedUserId: string,
    remote_data?: boolean,
  ): Promise<ApiResponse<ContactResponse>> {
    try {
      //TODO: handle case where data is not there (not synced) or old synced
      const job_resp_create = await this.prisma.events.create({
        data: {
          id_event: uuidv4(),
          status: 'initialized',
          type: 'crm.contact.pull',
          method: 'GET',
          url: '/crm/contact',
          provider: integrationId,
          direction: '0',
          timestamp: new Date(),
          id_linked_user: linkedUserId,
        },
      });
      const job_id = job_resp_create.id_event;
      const contacts = await this.prisma.crm_contacts.findMany({
        where: {
          remote_id: integrationId.toLowerCase(),
          events: {
            id_linked_user: linkedUserId,
          },
        },
        include: {
          crm_email_addresses: true,
          crm_phone_numbers: true,
        },
      });

      const unifiedContacts: UnifiedContactOutput[] = await Promise.all(
        contacts.map(async (contact) => {
          // Fetch field mappings for the contact
          const values = await this.prisma.value.findMany({
            where: {
              entity: {
                ressource_owner_id: contact.id_crm_contact,
              },
            },
            include: {
              attribute: true,
            },
          });
          // Create a map to store unique field mappings
          const fieldMappingsMap = new Map();

          values.forEach((value) => {
            fieldMappingsMap.set(value.attribute.slug, value.data);
          });

          // Convert the map to an array of objects
          const field_mappings = Array.from(
            fieldMappingsMap,
            ([key, value]) => ({ [key]: value }),
          );

          // Transform to UnifiedContactInput format
          return {
            id: contact.id_crm_contact,
            first_name: contact.first_name,
            last_name: contact.last_name,
            email_addresses: contact.crm_email_addresses.map((email) => ({
              email_address: email.email_address,
              email_address_type: email.email_address_type,
            })),
            phone_numbers: contact.crm_phone_numbers.map((phone) => ({
              phone_number: phone.phone_number,
              phone_type: phone.phone_type,
            })),
            field_mappings: field_mappings,
          };
        }),
      );

      let res: ContactResponse = {
        contacts: unifiedContacts,
      };

      if (remote_data) {
        const remote_array_data: Record<string, any>[] = await Promise.all(
          contacts.map(async (contact) => {
            const resp = await this.prisma.remote_data.findFirst({
              where: {
                ressource_owner_id: contact.id_crm_contact,
              },
            });
            const remote_data = JSON.parse(resp.data);
            return remote_data;
          }),
        );

        res = {
          ...res,
          remote_data: remote_array_data,
        };
      }
      await this.prisma.events.update({
        where: {
          id_event: job_id,
        },
        data: {
          status: 'success',
        },
      });

      return {
        data: res,
        statusCode: 200,
      };
    } catch (error) {
      handleServiceError(error, this.logger);
    }
  }
  //TODO
  async updateContact(
    id: string,
    updateContactData: Partial<UnifiedContactInput>,
  ): Promise<ApiResponse<ContactResponse>> {
    try {
    } catch (error) {
      handleServiceError(error, this.logger);
    }
    // TODO: fetch the contact from the database using 'id'
    // TODO: update the contact with 'updateContactData'
    // TODO: save the updated contact back to the database
    // TODO: return the updated contact
    return;
  }
}
