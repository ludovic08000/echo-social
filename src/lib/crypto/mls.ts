export function createGroupSession(groupId, members){
  return {
    groupId,
    members,
    epoch: 0
  };
}

export function addMember(session, member){
  session.members.push(member);
  session.epoch++;
  return session;
}

export function removeMember(session, member){
  session.members = session.members.filter(m=>m!==member);
  session.epoch++;
  return session;
}