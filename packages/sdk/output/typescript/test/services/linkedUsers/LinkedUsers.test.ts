import nock from 'nock';

import { Testsdk } from '../../../src';

import { LinkedUsersService } from '../../../src/services/linkedUsers/LinkedUsers';

describe('test LinkedUsersService object', () => {
  it('should be an object', () => {
    expect(typeof LinkedUsersService).toBe('function');
  });
});

describe('test LinkedUsers', () => {
  let sdk: any;

  beforeEach(() => {
    sdk = new Testsdk({});

    nock.cleanAll();
  });

  describe('test linkedUsersControllerAddLinkedUser', () => {
    test('test api call', () => {
      const scope = nock('http://api.example.com')
        .post('/linked-users/create')
        .reply(200, { data: {} });
      return sdk.linkedUsers
        .linkedUsersControllerAddLinkedUser({})
        .then((r: any) => expect(r.data).toEqual({}));
    });
  });

  describe('test linkedUsersControllerGetLinkedUsers', () => {
    test('test api call', () => {
      const scope = nock('http://api.example.com').get('/linked-users').reply(200, { data: {} });
      return sdk.linkedUsers
        .linkedUsersControllerGetLinkedUsers()
        .then((r: any) => expect(r.data).toEqual({}));
    });
  });

  describe('test linkedUsersControllerGetLinkedUser', () => {
    test('test api call', () => {
      const scope = nock('http://api.example.com')
        .get('/linked-users/single?id=2330477156')
        .reply(200, { data: {} });
      return sdk.linkedUsers
        .linkedUsersControllerGetLinkedUser('2330477156')
        .then((r: any) => expect(r.data).toEqual({}));
    });

    test('test will throw error if required fields missing', () => {
      const scope = nock('http://api.example.com')
        .get('/linked-users/single?id=9019964766')
        .reply(200, { data: {} });
      return expect(
        async () => await sdk.linkedUsers.linkedUsersControllerGetLinkedUser(),
      ).rejects.toThrow();
    });

    test('test will throw error on a non-200 response', () => {
      const scope = nock('http://api.example.com')
        .get('/linked-users/single?id=3751442506')
        .reply(404, { data: {} });
      return expect(
        async () => await sdk.linkedUsers.linkedUsersControllerGetLinkedUser('3751442506'),
      ).rejects.toThrow();
    });
  });
});